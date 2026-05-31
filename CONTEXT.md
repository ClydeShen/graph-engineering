# Graph-Native Agent Runtime

图原生 Agent 运行时系统的核心领域术语表。本系统以不可变事件图作为单一事实来源，通过去中心化事件总线驱动多 Agent 协作，借鉴区块链账本哲学实现状态不可篡改与自适应进化。

## 核心图原语

**Execution Graph（执行图）**：
系统的单一事实来源（SSOT）。所有工作流、记忆、任务分支皆是此图的局部拓扑。物理存储为 PostgreSQL append-only 事件日志，账本只增不减。
_Avoid_: 工作流图、任务图、状态机

**Entity（实体）**：
图中一个逻辑对象，生命周期内以稳定 UUID（Entity ID）标识，通过 Version 链记录其演化历史。
_Avoid_: 节点、对象、记录

**Version（版本）**：
Entity 在某一时刻内容的不可变快照，以 SHA-256 内容哈希（Version ID / version_hash）唯一标识。版本不覆写，只追加。
_Avoid_: 快照、状态、记录

**Version Hash（版本哈希）**：
通过密码学拼接矩阵 `{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}` 在 PostgreSQL 内核（pgcrypto）计算的 SHA-256 摘要。scope_id 作为密码学盐值灌入首位。
_Avoid_: 内容哈希、摘要、指纹

**Hyper-edge（事件不可变边）**：
图中的有向边，代表一个不可变的认知/执行事件元组 `(N_source, N_target, event_type, version_hash, timestamp)`。一经写入哈希即锁定，不可逆向修改或删除。
_Avoid_: 边、关系、事件记录

**Predecessor Hash（前驱哈希）**：
当前节点显式携带的前一版本的 version_hash，构成区块链式版本进化链条。图根节点（plan_created）无前驱。
_Avoid_: 父哈希、上一版本

**Orphan Node（孤岛节点）**：
由外部错误或 LLM 幻觉产生的死胡同分支节点。物理保留在账本中作为系统反思证据，不参与正统版本链推进。
_Avoid_: 死节点、废弃节点、错误节点

## 作用域与生命周期

**Scope（作用域容器）**：
专门用于跨多个 Context Window 进行物理群组化的宏观任务节点。所有在该宏观任务下派生的微观事件，通过 `member_of` 边强制锚定在此节点上。对应 PostgreSQL 中一张独立的 LIST 分区子表。
_Avoid_: 任务、会话、进程、Job

**Scope ID**：
Scope 的全局唯一标识符，同时作为密码学盐值压入该 Scope 内所有版本哈希的计算矩阵首位，实现跨 Scope 哈希碰撞的密码学级隔离。
_Avoid_: 任务 ID、会话 ID

**Scope 生命周期**：
- **启动**：三阶段筑巢协议（DDL）完成后注入首个 `plan_created` 事件
- **运行**：Worker 持续消费总线事件，推进版本链
- **关闭**：拓扑收敛看门狗（唯一合法来源）投递 `scope_closed` 事件
- **挂起（Suspended）**：Context OOM 三级熔断后，`context_oom_throttled` 写入，等待人工干预

**scope_lineage（作用域血缘冷表）**：
记录父子 Scope 因果关系的全局元数据冷表，在筑巢协议 DDL 事务中原子写入。不是事件日志，不受 append-only 约束。嵌套 Scope 机制（ADR 23，Phase 3）的物理基础。
_Avoid_: Scope 关系表、父子映射表

**`sub_scope_resolved`（子 Scope 结算信号）**：
子 Scope 关闭后由控制面守护线程向父分区直写的基础设施级信号，携带子 Scope 最终 version_hash 指针。不含业务语义，不经过总线枚举校验。触发 SubScopeResultWorker 执行语义合并。
_Avoid_: 子任务完成事件、回调事件

**SubScopeResultWorker**：
嵌套 Scope 专职结果合并器。被 `sub_scope_resolved` 唤醒，读取子 Scope 冷表尾部节点，调用 LLM 合成结果摘要，向父分区写回标准 `memory_updated`，处理完即销毁。
_Avoid_: 父 Scope 通知器、聚合器

**法定认知事件（Canonical Cognitive Events）**：
系统五大核心事件枚举，任何不在此枚举内的事件类型被总线拒绝：

| 事件类型 | 触发场景 |
|---|---|
| `plan_created` | 新 Scope 启动，图根节点 |
| `task_spawned` | 宏观任务拆解为子任务 |
| `memory_updated` | Worker 执行成功，版本链向前推进 |
| `conflict_detected` | OCC 乐观锁竞争失败，触发因果倒置 |
| `scope_closed` | 拓扑收敛看门狗终审通过 |

_Avoid_: 事件类型、消息类型、操作码

## 控制流与并发

**OCC（乐观并发控制）**：
利用数据库层 `UNIQUE(predecessor_hash, scope_id)` 唯一约束在单次 Writable CTE 事务内完成并发裁决：先到者写入 `memory_updated`，落后者原子降级为 `conflict_detected`（因果倒置）。
_Avoid_: 乐观锁、版本锁、CAS

**Writable CTE 原子因果倒置**：
OCC 的具体实现机制。落后者不抛异常，而是将 predecessor_hash 强制改写指向胜者（因果倒置），其 version_hash 基于倒置后的真实内容在事务内原子重算。Worker 收到 `won` 或 `demoted` 信号，无需重试。
_Avoid_: 冲突处理、回滚、重试

**Topological Horizon（拓扑视界）**：
大模型单次调用时，以当前处理节点为中心，由 Knapsack Slicing 算法动态生成的 DAG 切片。是 Worker 的完整上下文输入边界。
_Avoid_: 上下文窗口、输入、视野

**Knapsack Slicing（背包切片算法）**：
拓扑视界的生成算法。纵轴：沿 predecessor_hash 逆向追溯至 N_root（刚性因果骨架）；横轴：同 scope 内 pending/conflict 兄弟节点；在 W_max Token 预算内按时序倒序填充中间祖先。
_Avoid_: 上下文裁剪、截断、摘要

**Topological Convergence Watchdog（拓扑收敛看门狗）**：
系统内唯一有权产生 `scope_closed` 事件的组件，内嵌于 iii-engine 控制路径。三级防御：内存原子计数器 → 冲突拓扑锁 → 数据库 B-Tree 终审 SQL。
_Avoid_: 完成判定器、超时器、监控器

**Context OOM 三级降级链路**：
当拓扑视界切片后 `Size(N_root) + Size(N_current) > W_max` 时触发的三级自适应保护机制：一级蒸馏（N_root 战略意图压缩至 10–20%，LLM 辅助）→ 二级尾流截断（N_current 保留尾部 2000 Token）→ 三级刚性熔断（控制面写入 `context_oom_throttled`，Scope 进入 Suspended 状态）。
_Avoid_: OOM 报错、上下文溢出异常

**`context_oom_throttled`（内核级挂起事件）**：
由控制面守护线程在 Context OOM 三级熔断时直接写入分区子表的基础设施级事件，不经过总线事件类型枚举校验，不触发任何 Worker 订阅。与 `scope_closed` 同级权限，写入后 Scope 进入 Suspended 状态，等待人工干预。
_Avoid_: 错误事件、异常记录

**Suspended（挂起）**：
Scope 因 `context_oom_throttled` 进入的特殊生命周期状态。拓扑收敛看门狗在检测到未解除的挂起事件时阻断 `scope_closed` 判定。只有控制面写入后续解除事件后 Scope 才可恢复运行。
_Avoid_: 暂停、冻结、错误状态

**Convergence Gate（收敛门）**：
收敛节点（v_merged）payload 内强制内嵌的双向锚定矩阵，包含 `legitimate_basis_hash`、`conflicted_basis_hash`、`clash_scope_root_hash`。收敛门落盘后，看门狗解除对当前 Scope 被挂起兄弟节点的流控阻断。
_Avoid_: 合并标记、收敛标记

## 双轨检索

**Deterministic Execution Track（确定性执行轨道）**：
Worker 被总线事件触发时自动激活。沿 predecessor_hash 链逆向追溯 + Knapsack 裁剪，从 `execution_event_log` 主表取强因果上下文。禁止向量模糊检索。
_Avoid_: 主轨道、执行上下文

**Divergent Reflection Track（发散性反思轨道）**：
仅在三种场景按需触发：`conflict_detected`、全局宏观规划、Scope 冷启动。查询三张记忆表，结果以 Background Context 身份注入 Prompt 独立分区。Token 预算上限 `min(2000, W_max × 0.3)`，超出按 Procedural > Episodic > Semantic 截断。
_Avoid_: 记忆检索、背景知识注入

## 四层记忆

**Working Memory**：
即 `execution_event_log` 主表。最原始、最精确的短期工作记忆，与执行图完全融合，无需额外建表。

**Episodic Memory（情景记忆）**：
`episodic_memory` 表。记录 Scope 关闭后的"发生了什么"——意图摘要 + 结果摘要 + key_entities + error_patterns。HNSW 向量检索。

**Semantic Memory（语义记忆）**：
`semantic_memory` 表。跨 Scope 归纳的通用事实知识。通过 `superseded_by` 自引用外键维护知识版本链，旧事实物理不删除，HNSW 部分索引（`WHERE superseded_by IS NULL`）将其隔离出检索空间。

**Procedural Memory（程序记忆）**：
`procedural_memory` 表。正/负样本分离存储（`is_anti_pattern`）。正样本为黄金工作流模版骨架（`template_graph`），负样本为失败模式档案。冷启动时两阶段 Top-20 ANN + 三信号混合重排（相似度×0.6 + 质量×0.3 + 时效×0.1）。

**Skeleton Graph（骨架图）**：
冷启动匹配成功后，从 procedural_memory 取出的 `template_graph`，直接拍入新 Scope 的图账本作为初始拓扑骨架，Worker 无需从零规划直接认领任务。
_Avoid_: 模板、初始图、工作流模版

## 基础设施

**iii-engine**：
底层高性能统一异步事件总线（Rust 实现）。负责订阅路由（内存 DashMap）、HWM 水位线推进、WebSocket 推送、断线补发。
_Avoid_: 消息队列、事件总线、中间件

**HWM（High-Water Mark，水位线）**：
iii-engine 在 `bus_state` 表中异步维护的 `last_processed_event_id`。断线重连后从 HWM 补发漏发事件，无论历史积累多少均不触发全量重放。
_Avoid_: 偏移量、游标、检查点

**Control Plane（控制面）**：
iii-engine 内部专职守护线程，独占 DDL 权限。执行三阶段筑巢协议（拦截意图 → 独占 DDL → 开闸放水）。数据面 Worker 账户权限硬限缩为纯 `SELECT/INSERT`。
_Avoid_: 管理面、DDL 执行器

**Worker**：
挂载在 iii-engine 总线上的去中心化执行单元。声明 JSON Schema 订阅契约，监听匹配事件，调用外部工具或 LLM，将标准产物写回执行图。处理完即销毁独立 Context Window。
_Avoid_: Agent、服务、进程

**ConflictResolverWorker**：
热路径专职合并器。被 `conflict_detected` 唤醒，启动独立 Context Window 读入分叉两端，语义合并后输出收敛节点 v_merged。

**TemplateProposalWorker**：
冷路径专职模版提炼器。被 `scope_closed` 唤醒，审计 Scope 完整 DAG，提炼正/负样本，分别写入 procedural_memory 和 episodic_memory。

**Wasm Tokenizer（Wasm 分词旁路）**：
连接网关层挂载的 WebAssembly 旁路插件，<1ms 内计算精确 Token 数，结果写入 `payload._meta.tokens[model_fingerprint]`，作为 Knapsack 算法数理依据。
_Avoid_: Token 计数器、tiktoken

**△_padding（动态安全垫片）**：
每个 Worker 通道独立维护的弹性 Token 缓冲（初始值 4096）。总线拦截模型响应真实 `usage.prompt_tokens`，若发生估算漏损，以 1.5 倍惩罚性加权自适应撑大。

---

## 示例对话

**开发者**：我要在 Scope A 里新增一个 Entity，直接覆写现有节点行不行？

**领域专家**：不行，执行图是 append-only 的账本。你需要追加一个新 Version，新版本的 predecessor_hash 指向你想修改的那个节点的 version_hash。

**开发者**：如果两个 Worker 同时想修改同一个 Entity 怎么办？

**领域专家**：数据库层的唯一约束会裁决：先到者写 `memory_updated`，推进正统链；落后者被原子降级为 `conflict_detected`，因果倒置——predecessor_hash 强制改写指向胜者。ConflictResolverWorker 随后被唤醒做语义合并。

**开发者**：那大模型怎么知道当前任务的上下文？

**领域专家**：Worker 被触发时，热图计算层先跑 Knapsack Slicing，沿 predecessor_hash 链逆向追溯到 N_root（用户原始意图），横向加入同 Scope 内的 pending 兄弟节点，在 W_max Token 预算内装填，这就是拓扑视界。

**开发者**：反思记忆什么时候注入？

**领域专家**：只有三种场景：遇到 `conflict_detected`、做全局宏观规划、或者 Scope 冷启动匹配骨架图时。平时 Worker 只走确定性执行轨道，沿版本链往回追就够了。

---

## 标记歧义

**「节点」（node）**：文档中同时指代 Entity 的某个 Version（图节点）和 Scope 容器节点。统一规范：图节点 = Version，宏观容器 = Scope。

**「冲突」（conflict）**：可能指 OCC 并发写冲突（触发 `conflict_detected`），也可能指 ConflictResolverWorker 的语义合并对象。前者是数据库层事件，后者是控制流阶段，两者不同。
