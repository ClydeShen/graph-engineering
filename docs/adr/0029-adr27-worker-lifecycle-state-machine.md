# ADR 27｜Worker 执行生命周期状态机

status: accepted  
日期: 2026-06-01  
研究来源: G5 缺陷（Pre-Phase-1 比较研究）

---

## 上下文

现有设计将 Worker 描述为"订阅事件 → 调用 LLM → 写回账本"的三步黑盒。比较研究（参照 kli）发现以下问题：

1. 没有明确的 Worker 状态机规约，两套独立实现可能在边界行为上分歧
2. Knapsack 组装失败的处置路径未定义，存在"触发事件被静默跳过 → Pending 计数永不归零 → 看门狗死锁活锁"的毁灭性路径
3. Worker 生命周期内的内存突变规范缺失，无法从架构层保证 Worker 无副作用

---

## 决策

### 四阶段确定性状态机

每一个 Worker 实例（沙箱）从被触发到被销毁，强制受控于以下四阶段状态机：

```
[Initializing]
    │  断言：Knapsack 上下文组装完毕
    │  失败处置：见"Knapsack 组装失败路径"
    ▼
[Processing]
    │  铁律：禁止任何持久化的内存突变
    │  活动：调用 LLM，生成意图 payload
    ▼
[Writing]
    │  断言：Gateway Zod + Regex 铁闸校验通过（ADR 24）
    │  活动：OCC 写入（ADR 03），微内核接管此阶段
    ▼
[Terminated]
       沙箱物理销毁，释放 Context Window 句柄
```

**状态转移规则：**

| 转移 | 触发条件 | 失败处置 |
|------|---------|---------|
| Initializing → Processing | Knapsack 切片成功（`Size(N_root) + Size(N_current) ≤ W_max`） | 见 Knapsack 失败路径 |
| Processing → Writing | LLM 返回合法 payload | LLM 超时/报错 → 写 `conflict_detected`（ADR 05 自愈回路） |
| Writing → Terminated | OCC 写入落盘（`won` 或 `demoted`） | Zod 校验失败 → 丢弃 payload，沙箱销毁，事件重入队 |

**Processing 阶段铁律：**  
Worker 沙箱在 Processing 阶段期间，禁止向任何持久化存储（PostgreSQL、文件系统、外部缓存）写入任何中间状态。LLM 调用结果在内存中暂存直至 Writing 阶段由微内核接管。违反此铁律的实现视为架构违规。

---

### Knapsack 组装失败路径

Knapsack 组装失败分为两种根本不同的原因，处置路径完全不同：

#### 原因 A：上下文过大（Context OOM）

**判定条件：** `Size(N_root) + Size(N_current) > W_max`（即当前 Scope 的历史积累已超过模型物理窗口容量）

**处置：** 触发 OOM 三级降级链路（ADR 13 补充）：

```
Level 1 蒸馏：N_root 战略意图压缩至 10–20%（LLM 辅助，⚠️ 唯一 LLM 调用点）
    │ 若蒸馏后仍超限 →
Level 2 截断：N_current 保留尾部 2000 Token
    │ 若截断后仍超限 →
Level 3 熔断：控制面直写 context_oom_throttled，Scope → Suspended
```

此路径不重入队——相同条件重试只会得到相同失败结果。直接升级到 OOM 链路。

#### 原因 B：系统资源限制（Overload）

**判定条件：** 当前 Scope 内活跃沙箱数 ≥ `Max_Parallelism`（调度层限流，非上下文内容问题）

**处置：** 挂起 + 带重试上限的重入队：

```
触发事件 → 系统过载判定
    │
    ▼
FIFO 内存挂起队列（令牌桶背压，100–300ms）
    │
    ▼
重试计数 += 1
    │
    ├── 重试次数 < 3 → 下次令牌桶放行后重新尝试 Initializing
    │
    └── 重试次数 ≥ 3 → 降级为 Context OOM 路径（Level 3 熔断）
```

**重试上限 N=3：** 3 次重试失败代表 Scope 长期资源饱和，继续等待无意义。直接触发 `context_oom_throttled` 将 Scope 挂起，等待人工干预或资源恢复后解除。

**关键不变量：** 无论哪条失败路径，被触发的原始事件在系统的 Pending 计数中始终被持有，直到该 Scope 的 `context_oom_throttled` 状态被解除或事件通过 Terminated 阶段正常落盘。看门狗的代数收敛判定（ADR 19 + ADR 28）不会在活锁状态下误触发 `scope_closed`。

---

## 与 OOM 三级链路的关系

ADR 13 补充文档定义的三级 OOM 降级是"Worker 上下文内容问题"的处置机制（原因 A）。  
ADR 27 在此基础上补充"系统资源饱和问题"的处置机制（原因 B），两者互不重叠：

| 问题类型 | 入口 | 出口 |
|---------|------|------|
| 上下文过大（内容） | Initializing 失败（原因 A） | OOM 三级链路 |
| 系统过载（资源） | Initializing 失败（原因 B） | 重入队 → N=3 重试上限 → OOM 三级链路 |

---

## 后果

- iii-engine 微内核必须实现四阶段状态追踪（至少在 Scope 粒度维护活跃沙箱计数）
- 所有 Worker 实现代码禁止在 Processing 阶段之外维护跨事件的内存状态
- Knapsack 失败不再是"跳过"——任何触发事件都有明确的最终归宿（落盘或 Suspended）
- Phase 1 实现需要在 iii-config.yaml 中定义初始 `Max_Parallelism`（见 ADR 28）

---

## 关联 ADR

- **ADR 03** — Writable CTE OCC：Writing 阶段的物理实现
- **ADR 05** — Scope 筑巢协议：Worker 权限隔离
- **ADR 13 补充** — OOM 三级降级链路（原因 A 的处置）
- **ADR 19** — 拓扑收敛看门狗：依赖 Pending 计数不被静默丢弃
- **ADR 24** — Gateway Zod 铁闸：Writing 阶段校验
- **ADR 28** — 调度规约：`Max_Parallelism` 定义与令牌桶实现
