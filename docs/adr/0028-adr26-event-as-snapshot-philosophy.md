# ADR 26｜Event-as-Snapshot 哲学：状态推导与重放验证模型

status: accepted  
日期: 2026-06-01  
研究来源: G8 缺陷（Pre-Phase-1 比较研究）

---

## 上下文

Pre-Phase-1 比较研究将本系统与 kli（kleisli-io）进行对照时，发现一个核心语义空白：**系统缺乏"如何从事件日志推导当前状态"的显式规约**。kli 使用 CRDT 读时融合（fold/reduce over events），这在 kli 中是正确的——因为 kli 的事件是增量 delta（OR-Set、LWW-Register 合并）。

本系统与 kli 的根本设计区别：

| 维度 | 本系统 | kli |
|------|--------|-----|
| 事件写入时机 | OCC + Writable CTE 原子写入，冲突即时固化为 `conflict_detected` | CRDT 读时融合 |
| 冲突语义 | 冲突 DAG 是一等公民，永久保留在账本 | CRDT 合并后无冲突记录 |
| 状态写入模型 | **Event-as-Snapshot** | Event-as-Delta |
| 状态推导方式 | 直接读取因果链顶端节点 | Replay + CRDT merge |

错误方向（已拒绝）：沿 `predecessor_hash` 逆向追溯所有节点，对 payload 字段做 `reduce((state, event) => ({ ...state, ...event.payload }))` 叠加。此方案在本系统中产生字段污染——`conflict_detected`、`task_spawned`、`memory_updated` 的 payload schema 完全不同，不可叠加。

---

## 决策

### 核心命题：Event-as-Snapshot

**每一个 `memory_updated` 事件本身就是该实体当前状态的完整快照，而非差量补丁（Delta）。**

实体 X 的当前 canonical 状态不需要沿历史链 fold，直接读取因果链顶端节点 payload：

```sql
-- 状态推导的物理实现：直抓顶端快照
SELECT payload
FROM execution_event_log_scope_{id}
WHERE entity_id = $entity_id
  AND version_hash = $canonical_tip_hash;
```

`$canonical_tip_hash` 由调用方从上下文中持有（API 响应、Knapsack 切片结果、或版本链查询）。系统不需要实现全局"当前状态视图"——每次写入都是完整快照，每次读取都是直接命中。

### 重放验证：Hash 确定性，不是 State 投影

RFC §6.1 定义的"确定性重放验证"含义是：**给定相同的事件序列，重算每个节点的 `version_hash`，结果与历史账本密文碰撞**。

这是 **哈希确定性**，不是状态投影确定性：

```
重放验证路径：
给定事件日志 [E1, E2, ... En]
  → 对每个事件 Ei 重新执行哈希计算：
      digest(scope_id|entity_id|predecessor_hash|event_type|canonical_json(payload))
  → 断言：计算结果 == Ei.version_hash（历史账本值）
  → 所有节点通过 → 重放验证成功
```

重放验证的目标是证明"事件日志未被篡改，且哈希函数实现无隐藏副作用"，而非"从日志可以重建任何任意中间状态"。

### 状态推导的物理路径汇总

| 需求 | 物理路径 |
|------|---------|
| 获取实体 X 当前状态 | `SELECT payload WHERE entity_id=$x AND version_hash=$tip` |
| 获取实体 X 的版本历史 | 沿 `predecessor_hash` 链逆向追溯（Knapsack Slicing） |
| 验证事件日志完整性 | 重算每个节点的 `version_hash`，密文碰撞检验 |
| Scope 聚合视图 | Knapsack 切片（ADR 13），不是全量 fold |

---

## 拒绝的方案

### fold/reduce 状态投影

```typescript
// ❌ 拒绝：payload spread 会产生字段污染
const state = causalChain.reduce((s, e) => ({ ...s, ...e.payload }), {});
```

- `task_spawned` payload 含 `{ task_description, status: "pending" }`
- `conflict_detected` payload 含 `{ actual_basis_hash, conflict_reason }`
- `memory_updated` payload 含完整业务状态

三者叠加产生的对象不对应任何有效的业务状态。本系统不是 event-sourced CQRS with deltas——每个 `memory_updated` 写入时即为完整快照，历史 fold 不仅无必要，且语义错误。

### 全局"当前状态"物化视图

- 对 append-only 事件日志维护物化视图会引入写放大
- Scope 分区设计（ADR 04）使跨分区物化视图在 DDL 层面复杂
- 非必要：Knapsack 切片已经是按需的局部物化，性能完全满足 Phase 1 需求

---

## 后果

- Worker 在写入 `memory_updated` 时必须写完整状态 payload，禁止依赖调用方合并前序字段
- API 响应（ADR 24 AssembledContext）直接返回当前 `memory_updated` payload，不做额外聚合
- 重放验证（RFC §6.1）测试套件只验证 `version_hash` 密文碰撞，不验证状态语义正确性（状态语义验证属于业务测试范畴）
- Phase 1 实现中禁止出现任何形式的"沿历史链聚合字段"代码——发现此类代码视为架构违规

---

## 关联 ADR

- **ADR 02** — Scope 盐化内容寻址：`version_hash` 计算规范
- **ADR 03** — Writable CTE OCC：写入时冲突处理，冲突 DAG 固化
- **ADR 13** — Knapsack Slicing：按需局部历史投影（非全量 fold）
- **ADR 19** — 拓扑收敛看门狗：基于 `payload->>'status'` 的任务完成判定（P0-I 约定）
