# ADR 28｜调度规约与操作确定性

status: accepted  
日期: 2026-06-01  
研究来源: G6 + G7 缺陷（Pre-Phase-1 比较研究）

---

## 上下文

比较研究暴露了两个互相关联的缺陷：

**G6 — 无操作确定性规范：** 收敛看门狗（ADR 19）拥有正确的 SQL 逻辑，但没有正式声明该逻辑是纯代数的、无概率判定的。两套独立的 iii-engine 实现若在控制流决策上引入任何启发式分支，将产生行为分歧。

**G7 — 无调度规范：** iii-engine 通过 DashMap 订阅路由分发事件，但以下问题无答案：
- 10 个 `task_spawned` 事件同时到达时，并发上限是多少？
- `ConflictResolverWorker` 被重复触发时如何防止重复实例化？
- 背压模型在哪里实现？

---

## 决策

### 第一部分：操作确定性声明（G6）

**收敛判定是纯代数函数，没有任何概率、统计、或启发式成分。**

看门狗的唯一判定标准：

$$\text{is\_converged} = (\text{pending\_tasks} = 0) \land (\text{open\_conflicts} = 0)$$

两个计量的精确 SQL 定义（基于 ADR 19 v3，重构为 WITH 子句以提高可读性）：

```sql
-- ADR 28 操作确定性版本：看门狗代数收敛终审查询
-- 语义等价于 ADR 19 Level 3 SQL（UNION ALL 版本），更易独立测试
WITH scope_stats AS (
  SELECT
    -- pending_tasks：有 task_spawned 但无对应 memory_updated(status=completed)
    (
      SELECT COUNT(DISTINCT t.entity_id)
      FROM execution_event_log_scope_{id} t
      WHERE t.event_type = 'task_spawned'
        AND NOT EXISTS (
          SELECT 1
          FROM execution_event_log_scope_{id} m
          WHERE m.entity_id = t.entity_id
            AND m.event_type = 'memory_updated'
            AND m.payload->>'status' = 'completed'
        )
    ) AS pending_tasks,

    -- open_conflicts：有 conflict_detected 但无对应 convergence_gate 收敛节点
    (
      SELECT COUNT(*)
      FROM execution_event_log_scope_{id} c
      WHERE c.event_type = 'conflict_detected'
        AND NOT EXISTS (
          SELECT 1
          FROM execution_event_log_scope_{id} v
          WHERE v.event_type = 'memory_updated'
            AND v.entity_id = c.entity_id
            AND v.payload->'_meta'->'convergence_gate'->>'conflicted_basis_hash'
                = c.version_hash
        )
    ) AS open_conflicts
)
SELECT (pending_tasks = 0 AND open_conflicts = 0) AS is_converged
FROM scope_stats;
```

**字段约定（P0-I）：**
- `task_spawned` 写入时：`payload.status = "pending"`
- `memory_updated`（任务完成）写入时：`payload.status = "completed"`
- 这两个值是系统级约定，Worker 和 API 层均强制遵守

**确定性保证机制：**  
两套独立的 iii-engine 实现执行此 SQL，由于 PostgreSQL ACID 隔离性（`READ COMMITTED` 或更高级别），任何时刻读取同一 Scope 的事件日志将得到相同的 `is_converged` 值。

**被禁止的判定方式：**
- 基于时间窗口的推断（"超过 N 秒无新事件则认为收敛"）
- 基于内存计数器的近似计数（内存计数只作为 Level 1 快速路径，Level 3 终审必须走 SQL）
- 任何形式的概率阈值

---

### 第二部分：调度规约（G7）

#### 最大并发度（Max_Parallelism）

**Max_Parallelism** 是单 Scope 内同时处于 Processing 状态的 Worker 沙箱上限。该值由 iii-config.yaml 在启动时动态计算，不硬编码：

```yaml
# iii-config.yaml
scheduling:
  tpm_limit: 500000          # API Key 的每分钟 Token 上限（来自 LLM Provider 配置）
  avg_tokens_per_call: 32768 # 单次 Worker 调用平均消耗（含 Knapsack 上下文）
  avg_call_duration_sec: 15  # 单次 Worker 调用平均生命周期（推理 + 网络 I/O）
  # Max_Parallelism 在 iii-engine 启动时自动计算（见下方公式），不配置固定值
```

**推导公式：**

$$\text{calls\_per\_min\_per\_channel} = \frac{60}{\text{avg\_call\_duration\_sec}}$$

$$\text{tpm\_per\_channel} = \text{calls\_per\_min\_per\_channel} \times \text{avg\_tokens\_per\_call}$$

$$\text{Max\_Parallelism} = \left\lfloor \frac{\text{tpm\_limit}}{\text{tpm\_per\_channel}} \right\rfloor$$

**默认参数代入验算（参考值，非硬编码）：**

$$\text{calls\_per\_min} = 60/15 = 4$$

$$\text{tpm\_per\_channel} = 4 \times 32768 = 131072$$

$$\text{Max\_Parallelism} = \lfloor 500000 / 131072 \rfloor = 3$$

注：实际默认值受 `tpm_limit`、`avg_tokens_per_call`、`avg_call_duration_sec` 三个参数共同决定。调整任一参数，iii-engine 重启后自动重算。Phase 1 建议从保守值（Max_Parallelism=3）开始，基于实测调整。

#### 令牌桶限流与 FIFO 队列

```
[ 事件到达 DashMap 路由 ]
        │
        ▼
[ 令牌桶检查：活跃沙箱数 < Max_Parallelism? ]
        │
   是 ──┤ 立即激活 Worker 沙箱（Initializing 阶段）
        │
   否 ──┤ 推入 Scope 级 FIFO 内存挂起队列
        │    └── 等待令牌桶放行（被动唤醒，非轮询）
        └──────────────────────────────────────────
```

**背压边界：** HWM（ADR 08）处理的是"事件交付"的 at-least-once 保证；令牌桶处理的是"事件处理"的并发限流。两者在不同层次运作，互不干扰。

**FIFO 队列持久性说明（Phase 1）：** 挂起队列为 in-memory，iii-engine 重启后队列丢失。但 HWM 机制保证重启后从 `last_processed_event_id` 重放，所有未处理事件将重新进入调度路径，不丢失。

**Phase 3+ 升级路径：** 如部署多节点 iii-engine，令牌桶需替换为分布式限流实现（Redis Lua 脚本或等价方案）。Phase 1 单节点 in-memory 实现是安全的起点。

#### ConflictResolverWorker 单写者互斥（Single-Writer Mutex）

**问题：** `conflict_detected` 事件已经通过总线订阅触发 ConflictResolverWorker。如果同一实体短时间内产生多个 `conflict_detected`，可能重复实例化多个 ConflictResolverWorker 处理同一实体，产生 v_merged 写冲突。

**决策：** 全线收拢至单一总线订阅路径，在路由层增加实体级互斥锁：

```
[ conflict_detected 事件到达 ]
        │
        ▼
[ ActiveResolverRegistry.has(entity_id)? ]
        │
   否 ──┤ 注册 entity_id，激活 ConflictResolverWorker（独占）
        │    └── 完成后：删除注册 → 处理 ScopePendingQueue 队头（如有）
        │
   是 ──┤ 推入 ScopePendingQueue（entity_id 级挂起队列）
        └── 等待当前 Resolver 完成后串行消费
```

**实现约束（Phase 1）：**
- `ActiveResolverRegistry`：`DashMap<EntityId, bool>`，in-memory，Scope 内单节点安全
- `ScopePendingQueue`：`DashMap<EntityId, VecDeque<Event>>`，in-memory
- iii-engine 重启后：现有 `conflict_detected` 事件由 HWM 重放，重新触发订阅，ConflictResolverWorker 幂等处理（OCC 会拦截重复写入同一 v_merged）

**Phase 3+ 升级路径：** 多节点部署时，`ActiveResolverRegistry` 需替换为分布式锁（Redis SETNX + TTL）。

**严禁的替代方案：** 在调度层另起独立计数器（"连续 N 次 OCC 失败 → 触发 Resolver"）。此方案与总线订阅路径形成双触发，产生重复 Resolver 实例化，是 G7 研究中明确排除的死路。

---

## 推迟的研究项（G1-G4，Phase 2/3）

以下四项缺陷在本次 Pre-Phase-1 研究中被识别，但不阻塞 Phase 1 实现，列为 Phase 2/3 前置研究：

| 编号 | 缺陷 | 相关系统 | 阻塞阶段 |
|------|------|---------|---------|
| G1 | 无遍历代数（Traversal Algebra）：Knapsack 是固化 SQL，无法表达临时图遍历查询（跨域拓扑分析） | Cayley（Gizmo API） | Phase 2（CrossScopePatternDiscovery） |
| G2 | 无形式化模式定义语言：TemplateProposalWorker 用 LLM 提取模式，非可验证的子图模式 | Peregrine（FSM） | Phase 2（WL 嵌入 + 精确模式定义） |
| G3 | 无嵌入训练策略：ADR 25 定义了 `topology_embedding vector(128)` 的维度与索引，但训练循环、评估指标、增量更新协议未定义 | GraphVite | Phase 1 schema 必须预留列，训练策略 Phase 2 定义 |
| G4 | 无物化遍历路径：Knapsack 每次从原始事件日志计算，无预算路径缓存。深度 Scope 下 Knapsack 查询延迟线性增长 | codegraph（预索引） | Phase 2（性能优化，非正确性问题） |

**G3 对 Phase 1 的影响：** `procedural_memory` 的 `topology_embedding vector(128)` 列（ADR 25）必须在 Phase 1 schema 中正确声明，即使训练逻辑 Phase 2 才实现。Phase 1 TemplateProposalWorker 计算 WL 嵌入并写入（stub 实现）。

---

## 后果

- iii-engine 实现必须严格按 SQL 终审判定收敛，禁止引入任何时间窗口、近似计数或概率阈值
- `Max_Parallelism` 由配置文件参数动态计算，Phase 1 实现需在启动日志中打印当前计算值
- ConflictResolverWorker 的激活路径收拢为单一总线订阅 + 实体级互斥，禁止在调度层另起触发计数器
- G1-G4 四项研究缺陷列入 `未决问题追踪.md`，Phase 2 规划前必须评估实现代价

---

## 关联 ADR

- **ADR 08** — HWM 水位线：事件交付保证层（与调度层互补）
- **ADR 09** — LISTEN/NOTIFY Pulse-Fetch：事件到达 DashMap 路由的上游
- **ADR 13** — Knapsack Slicing：G4 物化遍历路径优化的改造目标
- **ADR 18** — 收敛节点写回：ConflictResolverWorker 的输出协议
- **ADR 19** — 拓扑收敛看门狗：本 ADR 的操作确定性声明是 ADR 19 的语义补丁
- **ADR 24** — HTTP Gateway：调度层的上游事件入口
- **ADR 25** — 跨域拓扑算法：G3 嵌入训练策略的待补充 ADR
- **ADR 27** — Worker 生命周期：令牌桶限流（Max_Parallelism）的消费方
