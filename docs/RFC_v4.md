# 架构设计文档 (RFC)：基于区块链共识哲学的图原生 Agent 运行时系统
# Graph-Native Agent Runtime v4

---

## 1. 导言与背景 (Introduction & Background)

### 1.1 行业现状与核心痛点

当前 AI Agent 系统的开发模式存在严重的**"一次性工程 (Disposable Engineering)"**现象。开发者通常将 Agent 的思考逻辑、工具调用与控制流硬编码在特定的应用层代码中。这种做法导致了三大缺陷：

- **工具紧耦合**: 业务逻辑与底层特定工具（如某个具体的 API、数据库连接器）强绑定。一旦底层工具失效，整个 Agent 系统的控制流将直接中断，不具备自适应的容错能力。
- **工作流不可复用**: 针对特定场景构建的 Agent 编排代码无法直接无缝迁移到其他场景，即使两者的核心认知模式（拆解任务、调用工具、反思校验）高度一致。
- **上下文黑盒化与迷失**: 随着任务复杂度提升，由于缺乏确定性的记忆与控制流追溯机制，直接将历史丢给 LLM 容易引发上下文窗口（Context Window）爆满，或导致大模型发生**"迷失在中间 (Lost in the Middle)"**的严重幻觉。

### 1.2 项目愿景

本项目旨在构建一个以 **iii-engine 通用异步事件总线**为运行时基础设施的去中心化、图原生 (Graph-Native) Agent 运行时系统，面向 Claude Code、Pi 等外部 Agent 提供执行运行时服务。本系统借鉴了区块链 (Blockchain) 的账本与共识哲学，将系统的控制流、长期记忆与资产演进完全融合在一张不可变的"执行图 (Execution Graph)"中。系统不包含工作流层，工作流是从积累的执行历史中涌现的统计模式，而非预先设计或编排的组件。

> **注意**：Pi Agent（pi.dev）是一个外部 Agent 框架，是本系统的潜在消费者而非内置依赖。Pi Agent 原生 SDK 集成（`runtime.fork()` 沙箱）规划于 Phase 4，Phase 1 通过通用 Agent 接入协议支持任意 Agent 连接。

系统的最终目标是实现**工具彻底解耦**、**多上下文窗口物理群组化**以及**工作流无代码自适应进化**。

---

## 2. 核心思想与技术分工 (Core Philosophy & Architecture Layers)

系统的世界观建立在"关注点分离（Separation of Concerns, SoC）"的基础上，将 AI 时代的数据、大脑与四肢分为三个完全独立的层次：

### 2.1 三层解耦模型 (The Three-Layer Decoupling)

**1. 知识与状态层（Knowledge / Memory / Artifact）—— "本尊"**
- **技术实体**: 统一 Execution Graph（PostgreSQL append-only 事件图）、自建四层记忆库（Working/Episodic/Semantic/Procedural，全部统一在 PostgreSQL 内）。
- **职责**: 纯静态的数据资产，只进不出。作为不可变的事件日志，忠实记录 Agent 运行至今的每一笔认知和行为"流水账"，不包含任何执行逻辑。

**2. 方法与控制流层（Execution Control / Method）—— "大脑"**
- **技术实体**: 基于拓扑视界的 Knapsack 切片算法、认知事件模式匹配（通过 iii-engine 总线）、拓扑收敛看门狗。
- **职责**: 负责审视第一层的状态，动态决定下一步的抽象任务，控制执行流的整体走向。

**3. 工具与执行层（Tool Execution）—— "四肢"**
- **技术实体**: 通过通用微工人（Micro-workers）协议挂载到异步总线上的执行单元。
- **职责**: 完全去中心化的雇佣兵。它们不了解宏观任务，只负责监听总线分配的输入，调用外部 API 或环境，将标准产物写回第一层图。数据库账户权限硬限缩为纯 `SELECT/INSERT`。

### 2.2 技术组件与生态定义

- **iii-engine**: 底层高性能统一异步事件总线（基于 Rust 开发的高并发架构）。系统利用其核心的 Function（函数注册）和 Trigger（事件触发器）机制完成组件间去中心化通信。
- **四层记忆库**: 完全自建于 PostgreSQL 内，实现 Working/Episodic/Semantic/Procedural 四层记忆固化模型（源于人类认知心理学中的记忆分层理论），通过混合检索（向量库 + 图指针）手段实现高准确率的长期记忆管理。

---

## 3. 专有概念定义 (Domain-Specific Terminology)

### Execution Graph（执行图）
整个运行时的单一事实来源（Single Source of Truth, SSOT）。所有工作流、记忆、任务分支皆是此图的局部拓扑。物理存储为 PostgreSQL append-only 事件日志表，账本只增不减。存储于外部的分布式存储或索引层仅作为高性能缓存，图本身才是 canonical 主网。

### Entity & Version（实体与版本 - Scope 盐化内容寻址模型）
图中的节点模型，采用混合寻址方案：
- **Entity ID (UUID)**: 全局唯一且生命周期内不可变
- **Version ID (SHA-256)**: 节点内容的加密哈希戳，拼接矩阵：

  ```
  {scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}
  ```

  scope_id 作为密码学盐值压入首位，pgcrypto 内核计算，永不可变。

### Hyper-edge（事件不可变边）
引用自事件溯源（Event Sourcing）模式。图中的边代表一个不可变的、具有确定方向与时序的认知/执行事件元组，定义为：

```
Hyper-edge = (N_source, N_target, event_type, version_hash, timestamp)
```

- `N_source`: 事件触发的源头节点（父节点）
- `N_target`: 事件催生、演化出的新版本节点（子节点）
- 所有边一经写入，哈希即被锁定，绝对不可逆向修改或删除

### Scope Node（视界容器节点）
引用自操作系统的进程组（Process Group）概念。专门用于跨多个模型上下文窗口进行物理群组化（Grouping）的宏观任务节点。所有在该宏观任务下派生出的微观事件，其拓扑均通过 `member_of` 边强制锚定在此节点上。

**Scope 生命周期规范**:
- **启动**: 收到新用户意图时，控制面三阶段筑巢协议（ADR 05）创建分区子表并注入 `plan_created` 首个事件
- **关闭**: 拓扑收敛看门狗（ADR 19）三级防御终审通过后，投递 `scope_closed` 事件
- **嵌套**: 子 Scope 与父 Scope 通过 `child_of` 边连接，子 Scope 关闭事件自动向上传导为父 Scope 的有向依赖项

### Topological Horizon（拓扑视界）
引用自图论中的局部邻域与血缘追踪（Lineage Tracking）机制。大模型单次调用时，系统动态计算出的、以当前处理节点为中心的有向无环图（DAG）切片，由 Knapsack Slicing 算法（ADR 13）生成。

---

## 4. 核心系统架构与运行机制 (System Architecture & Execution)

### 4.1 数据模型：区块链式进化链条与版本树

任何节点的版本更新不是原地覆写（Mutation），而是追加（Append）新节点。新节点必须在结构中显式包含前驱版本的哈希（Predecessor Hash）。

这种设计天然保留了系统的"历史探索残迹"。在运行中，由于外部环境错误或 LLM 幻觉产生的分支会被标记为**"孤岛节点（Orphan Nodes）"**，作为系统反思避免再次踩坑的存证；而走通的路径通过前驱链不断向前收敛。

**冲突场景的完整拓扑**:
```
v_basis (H_basis)
    │
    ▼
v_1 (H_v1)          ← 正统行，memory_updated（先到者）
    │
    ▼
v_2 (H_v2)          ← 降级分叉行，conflict_detected（落后者因果倒置）
    │
    ▼
v_merged (H_merged) ← 收敛节点，predecessor_hash=H_v2，含 convergence_gate
```

### 4.2 控制流：基于总线订阅制的火炬传递

系统消灭了传统的中央控制代码，控制流推进采用基于事件驱动的协作模式（Choreography Pattern）。Worker 启动时声明自己感兴趣的 JSON Schema 契约（例如 `event_type == "task_spawned"`）。

**完整事件广播链路**:
1. Worker 写入新节点 → PostgreSQL AFTER INSERT 触发器
2. 触发器执行 `pg_notify('iii_engine_channel', '{"id": $event_id}')` （≤64字节）
3. iii-engine 监听到信号 → 只读连接池主键点查（<0.1ms）取完整数据
4. 内存 DashMap 路由表匹配订阅 → WebSocket 推送给对应 Worker
5. iii-engine 推进 HWM 水位线

**断线保底机制**:
iii-engine 重连后读取 `bus_state.last_processed_event_id`，补发所有 `event_id > HWM` 的漏发事件，随后平滑切回 LISTEN 模式。

### 4.3 并发与共识：图原生乐观锁与分支合并

当两个独立的微观上下文窗口同时并发尝试升级同一个节点时，系统采用 Writable CTE 原子因果倒置机制处理：

1. **写回冲突判定**: `UNIQUE(predecessor_hash, scope_id)` 唯一约束在数据库层拦截竞态
2. **图原生分支化**: 系统不抛出异常，落后者原子降级为 `conflict_detected` 节点，因果倒置，前驱指向胜者
3. **最终一致性共识**: ConflictResolverWorker 被唤醒，启动独立 Context Window，读入分叉两端，语义合并后输出收敛节点 v_merged，predecessor_hash 刚性指向 v_2

### 4.4 双轨检索与上下文注入机制 (Dual-Track Retrieval & Context Injection)

系统的检索哲学严格区分"干活（执行）"与"灵感（反思）"，iii-engine 按以下边界执行双轨注入：

**确定性执行轨道（Deterministic Execution Track）—— 强因果**
- **调用边界**: Worker 被总线事件触发，开始处理特定节点 N_current 时自动触发
- **机制**: 引擎必须且只能沿着 Execution Graph 的前驱版本链（Predecessor Hash Chain）逆向追溯，经 Knapsack Slicing 算法（ADR 13）裁剪后，获取该任务最精确、无幻觉的物理上下文和输入参数
- **数据来源**: `execution_event_log` 主表（Working Memory）

**发散性反思轨道（Divergent Reflection Track）—— 弱联想**
- **调用边界**: 仅当大模型在当前窗口遭遇以下情况时按需主动触发：
  - `conflict_detected`（工具报错、未知错误）
  - 需要进行全局多任务规划（Macro-planning）
  - Scope 冷启动，需要匹配黄金拓扑模版
- **机制**: 按需查询三张记忆表，结果作为 Background Context 注入 Prompt 独立分区

**反思轨道三层检索顺序**:
```
1. Procedural Memory（冷启动优先）
   → 两阶段 Top-20 ANN + 三信号混合重排
   → 找到黄金拓扑模版则直接拍入 Skeleton Graph

2. Episodic Memory（相似 Scope 经验）
   → HNSW 向量检索，按意图+结果摘要匹配
   → 注入"过去做过类似事情"的经验摘要

3. Semantic Memory（通用事实知识）
   → 部分索引 HNSW（WHERE superseded_by IS NULL）
   → 注入当前领域的已知事实和错误模式
```

**上下文隔离结构**:
```
[SYSTEM PROMPT]:    Core Schema Rules & Dynamic Domain Contracts
[EXECUTION CONTEXT]: Immutable Graph Lineage（确定性轨道，Knapsack 切片）
[REFLECTION MEMORY]: Procedural + Episodic + Semantic（发散性轨道，按需注入）
```

**Token 预算分配规范**:
```
W_max = W_physical - W_system_prompt - △_padding

执行上下文（确定性轨道）优先级最高，占 W_max 的主要份额
反思记忆（发散性轨道）预算上限 = min(2000 tokens, W_max × 0.3)
超出则按 Procedural > Episodic > Semantic 顺序截断
```

---

## 5. 实施规范与技术契约 (Implementation Specification)

### 5.1 核心静态契约 (Core Immutable Schema)

核心元语由运行时引擎死守，大模型无权修改。任何写入图的事件必须通过以下基础契约的静态校验：

- **结构完整性**: 必须包含合法的 `entity_id`（UUIDv4 格式）与 `version_hash`（标准 64 位十六进制哈希）
- **因果溯源性**: 除图根节点外，必须包含有效的 `predecessor_hash` 以维持区块链式的版本进化链条
- **事件类型约束**: 必须属于系统五大法定认知事件集（`plan_created`, `task_spawned`, `memory_updated`, `conflict_detected`, `scope_closed`）
- **Scope 盐化哈希**: 任何 `digest()` 调用前必须将 `scope_id` 作为第一要素压入字节流，系统拒绝接收未经 Scope 盐化处理的裸载荷哈希

### 5.2 动态业务类型契约 (Dynamic Domain Contract)

针对多变具体的业务场景，系统引入强类型接口契约机制（概念上类似 tRPC 的类型安全 API 契约，但本系统**不依赖 tRPC 框架**——契约存储于 `procedural_memory` 表，通过 iii-engine 总线注入 Worker 上下文）：

- 当系统在大模型运行过程中自适应地涌现并固化出某种特定业务类型的节点时，其类型规范会被注册到系统的程序记忆（`procedural_memory` 表）中
- 任何 Worker 在试图消费或处理该类型节点前，总线会强制将该业务契约转换为前置 Prompt 约束注入其 Context Window
- 这充当了大模型世界的"编译期类型检查（Compile-time Type Checking）"，确保物理隔离的窗口之间对数据字段拥有完全一致的认知

### 5.3 故障隔离与拓扑重试 (Fault Isolation)

系统执行具体外部工具时，遵循接口与实现分离原则：

- 图里的任务节点仅声明抽象接口任务（例如 `Interface: Extract_Text`）
- 在总线层，可以挂载多个具备相同订阅能力的工具微工人进行竞争或互备
- **自愈回路**: 若首选工具 Worker 发生硬性崩溃，它必须向图写回一个符合规范的 `conflict_detected` 节点，将错误上下文事件化。该事件触发总线，自动激活备用工具 Worker。工具的脆性崩溃被完全隔离在执行层，不会向上传导

---

## 6. 交叉验证与系统可自愈性设计 (Cross-Validation & Self-Healing Matrix)

### 6.1 确定性图重放验证法 (Deterministic Replay Test)

- **概念引用**: 软件工程中的确定性回放（Deterministic Replay）理论
- **验证机制**: 完整导出系统在运行一个复杂宏观任务（Scope 节点）时产生的全部不可变事件日志。在干净的隔离沙箱中，将这些日志通过总线按 BIGSERIAL 序列号顺序重新派发
- **交叉比对项**: 重新演化生成的最终状态节点之 Version ID（内容哈希），必须与历史真实任务结束时的哈希值实现 100% 密文碰撞。以此证实状态机没有任何隐藏状态或随机副作用

### 6.2 混沌容错与边界断言 (Chaos Testing & Assertions)

- **概念引用**: 分布式系统中的混沌工程（Chaos Engineering）机制
- **验证机制**: 在任务执行中途，通过拦截器对首选工具 Worker 进行硬件熔断，强制制造工具崩溃
- **交叉比对项**:
  - 拦截并断言系统主总线与核心控制层没有抛出任何未捕获代码异常
  - 检测图数据库中是否自动生长出 `conflict_detected` 拓扑
  - 校验备用 Worker 的入参，确保通过前驱版本链逆向追溯出的上下文数据完全符合动态业务契约规范

### 6.3 契约安全与群组化冲突压测 (Schema Structural Stress Test)

- **概念引用**: 数据库事务中的串行化隔离级别与类型安全测试
- **验证机制**: 并发启动大量微观 Worker 进程，在同一物理秒内向同一个 Scope 内的实体提交相互冲突的改动属性
- **交叉比对项**:
  - 查验总线的并发锁计数器，确保除首个成功写入的节点外，其余请求全部被强制降级为图的并行分叉分支
  - 触发合并后，调用 JSON Schema 自动化校验器强制对最终共识节点进行扫描，确保其属性符合注册在程序记忆中的强类型契约，无字段畸变

---

## 7. 系统的自适应进化机制 (Self-Evolution & Template Emergence)

本运行时系统最具革命性的能力在于：工作流模版不需要人类工程师编写，而是从图的生长和收敛中自动"涌现"并固化的。

### 7.1 矿工提案与主网升级机制 (Proposal & Upgrade Pattern)

- **概念引用**: 区块链治理中的分叉升级与改进提案（Improvement Proposals）机制

**运行机制**:

`scope_closed` 事件触发 TemplateProposalWorker，启动独立 Context Window 执行审计：

1. **正样本提取**: 读取该 Scope 完整 DAG，识别低冲突（`conflict_count` 低）、短耗时（`duration_ms` 低）的收敛拓扑路径，提取抽象接口边骨架
2. **负样本提取**: 扫描孤岛节点（Orphan Nodes），将"当前目标 + 导致失败的工具入参 + 孤岛节点错误 Payload"打包成反面程序记忆
3. **写入程序记忆**: 正样本写入 `procedural_memory`（`is_anti_pattern=FALSE`），负样本写入（`is_anti_pattern=TRUE`）
4. **写入情景记忆**: 同步写入 `episodic_memory`，记录该 Scope 的意图摘要与结果摘要
5. **更新语义记忆**: 提炼跨 Scope 通用事实，更新 `semantic_memory`（通过 `superseded_by` 维护知识版本链）

### 7.2 骨架拍入与冷启动优化 (Skeleton Initialization)

**运行机制**:

当系统收到新宏观任务时，iii-engine 在三阶段筑巢协议（ADR 05）完成后，立即执行冷启动匹配：

1. 对新 Scope 意图文本生成嵌入向量
2. 执行两阶段 Top-20 ANN + 三信号混合重排查询 `procedural_memory`
3. 若匹配到高分黄金模版（final_score > 阈值），将其 `template_graph` 作为初始骨架（Skeleton Graph）直接拍入图账本，同时更新 `last_used_at` 和 `success_count`
4. 同时查询反面程序记忆（`is_anti_pattern=TRUE`），将匹配到的失败模式注入 Worker 的 System Prompt 作为"禁止重蹈的坑"
5. 后续 Worker 直接顺着成熟骨架各自认领任务

**后果**: 达成完全不需要人类重写代码、系统越用越聪明、工作流无代码自适应进化的终极闭环。

---

## 8. 四层记忆物理架构 (Four-Tier Memory Physical Architecture)

本系统的四层记忆完全自建于 PostgreSQL 内，与 Execution Graph 统一在同一 SSOT。

### 8.1 记忆层级与职责

| 层级 | 物理存储 | 类比 | 写入时机 |
|---|---|---|---|
| **Working** | `execution_event_log`（主表） | 短期记忆 | 每次事件写入 |
| **Episodic** | `episodic_memory` | "发生了什么" | `scope_closed` 后 |
| **Semantic** | `semantic_memory` | "我知道什么" | 跨 Scope 归纳时 |
| **Procedural** | `procedural_memory` | "怎么做" | 模版提炼 + 失败归档时 |

### 8.2 记忆强化与衰减机制

- **Ebbinghaus 强化**: `reinforcement_count`（Semantic）和 `success_count`（Procedural）记录被多少 Scope 重复验证，检索时作为质量权重
- **时效衰减**: `last_used_at` 配合 30 天衰减周期，在冷启动查询中降低久未使用模版的权重
- **矛盾检测**: Semantic Memory 通过 `superseded_by` 自引用外键维护知识版本链，旧事实物理不删除（`ON DELETE RESTRICT`），但被 HNSW 部分索引（`WHERE superseded_by IS NULL`）隔离在检索空间之外

---

## 9. 系统架构全景图

```
┌─────────────────────────────────────────────────────────┐
│                    iii-engine 总线                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐   │
│  │控制面守护 │  │Pulse-Fetch│  │拓扑收敛看门狗         │   │
│  │(DDL权限) │  │(HWM+监听) │  │(scope_closed唯一源)   │   │
│  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘   │
│       │              │                    │               │
└───────┼──────────────┼────────────────────┼───────────────┘
        │              │                    │
┌───────▼──────────────▼────────────────────▼───────────────┐
│                  PostgreSQL 主网                            │
│                                                            │
│  execution_event_log（PARTITION BY LIST scope_id）          │
│  ├── execution_event_log_scope_A（UNIQUE predecessor+scope）│
│  ├── execution_event_log_scope_B                           │
│  └── ...                                                   │
│                                                            │
│  archived_event_log（冷归档，无唯一约束）                    │
│                                                            │
│  episodic_memory    （HNSW + 时序索引）                     │
│  semantic_memory    （部分HNSW, superseded_by=NULL）        │
│  procedural_memory  （正负样本双独立HNSW部分索引）           │
│                                                            │
│  bus_state          （HWM水位线）                          │
│  worker_subscriptions（订阅关系冷备份）                     │
│  worker_profiles    （△_padding 冷备份）                   │
└────────────────────────────────────────────────────────────┘
        ▲                    ▲
        │                    │
┌───────┴──────┐    ┌────────┴──────────────────────────────┐
│  Worker 层   │    │           Memory Synthesizer           │
│  (SELECT/   │    │  ConflictResolverWorker（热路径）        │
│   INSERT)   │    │  TemplateProposalWorker（冷路径）        │
│  Wasm Token │    │  各自独立 Context Window，处理完即销毁   │
│  旁路预检   │    └────────────────────────────────────────┘
└─────────────┘
```
