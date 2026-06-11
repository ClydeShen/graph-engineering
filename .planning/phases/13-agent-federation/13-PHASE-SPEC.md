# Phase 13: agent-federation — Phase Spec

**写入：** 2026-06-11
**用途：** `/gsd:discuss-phase 13` 与 planner 的前置输入。
**基线：** `.harness/ROADMAP.md` §13-agent-federation + 技术债轨道 TD-I/J/K/L；ADR-42（task_spawned/AgentCard/FrontierScheduler）；ADR-24。

---

## 1. 目标与定位

把"单 agent + 外挂工具"升级为"多 agent 共享一张图"。范式主张：**agent 之间不直接对话，经图协作**——没有编排层，协作模式从共享 Trail 涌现。本阶段三个待写 ADR（Lesson 可见性域、A2A 适配、OCC 冲突归因）共同回答一个问题：多个不完全互信的执行者写同一张图时，**读什么、写什么、冲突了算谁的**。

## 2. 设计要点（规划前必须消化）

### 2a. TD-I：AgentCard skill 粒度（本阶段第一个决策，P1-G 自 Phase 3 悬决）

倾向方案：**两级词表**——粗类目（`code`/`email`/`research`…，spawner 声明）+ 可选细标签（`typescript`/`sql-migration`…，同类目多候选时重排用）。spawner 不需要了解 executor 内部能力（解 P1-G 的核心矛盾）；Phase 3 的粗粒度词表天然成为第一级，零迁移。随多候选路由 ADR 一并写入 ADR-42 补充。

### 2b. 多候选竞争路由

同一 skill 多个 agent 声明时：`AgentCard.trust_level`（与 Phase 14 互锁，见 §6.1）+ 历史成功率（图上可查：该 agent 过往 Scope 的收敛率/冲突率）排序。SKIP LOCKED 原子派发已有，本阶段加排序层。**历史成功率查询复用 Phase 10 的指标埋点通路**（G7），不建新表。

### 2c. 内部 delegation（嵌套 Trail）

`sub-scope-result.worker` 已有基础。补齐：`max_concurrent_children` 可配（hermes 同款）、子 agent 模型 override、**父 Scope 可见子 Scope 的偏离与冲突**（不只是最终结果——这是相对 hermes delegation 的差异化，子 Trail 的 conflict 事件冒泡为父 Scope 的高权重 Knapsack 节点）。

### 2d. TD-J / TD-K（ADR-42 悬决项清账）

- **循环检测**：dispatch 时沿 `spawned_by` 链查环 → `ERR_CYCLE_DETECTED`（ADR-42 D-6）。嵌套 delegation 使环成为现实风险。深度上界与链查询用 recursive CTE，复用 `scope_lineage_view`。
- **wait_all_tasks 升级**：2 秒轮询 → LISTEN/NOTIFY 聚合。Phase 3 因 stateless MCP transport 选了轮询；现在 Gateway 有常驻进程（WS 已建），持久 pg-listen 订阅的架构障碍已消失。超时语义维持现状（`{timed_out, completed, pending}`）。

### 2e. Lesson 可见性域（新 ADR）

`agent-private` / `shared` / `global` 三域。设计要点：
- 加列迁移：`visibility TEXT NOT NULL DEFAULT 'global'`（Phase 10 §6.3 已确认默认回填廉价；CrystallizeWorker 的 options 参数位已留）
- 检索强制：`mem::reflect` 与混合检索 SQL 按请求方 principal 过滤——**这是安全语义不是建议语义**，private 泄漏即 bug
- 外部 agent 命中 shared Lesson 同样触发强化（系统从所有参与者变聪明）
- 域的判定者：蒸馏时 CrystallizeWorker 按 Scope 的参与者构成标注（单 agent scope → agent-private 默认，多方 scope → shared），用户可显式升 global

### 2f. OCC 冲突归因（新 ADR）

`occ-write` 已有冲突检测；扩展：冲突事件 payload 带双方 agent principal → 冲突是一等 Trail 数据进 Knapsack 高权重层（已有机制）→ 跨 agent 矛盾对 Phase 10 的负样本管道可见。归因不是裁决——本阶段不做自动冲突解决，ConflictResolverWorker 语义不变。

### 2g. A2A 协议适配（评估 + 最小实现）

外部 agent 不装 Memex 也能以 A2A 语义参与。最小实现 = AgentCard 与 A2A capability 声明的双向映射 + task 委托的协议桥。**评估先行**：discuss 阶段先出 A2A 规范现状短报告（ctx7/web 拉当期规范——该协议演进快，训练数据不可靠），若规范不稳则只做适配层接口预留，实现推 post-1.0。

### 2h. 跨渠道身份归一化

`same_as` Association：同一用户多渠道身份 = 同一 principal Entity 的别名。Phase 12 的显式续接升级为基于身份图的自动续接。人与 agent 共用 principal 模型（user / internal worker / external agent 都是图上 principal）。

## 3. 范围 Spec

**In scope：** 两级 skill 词表 + 多候选路由；内部 delegation 补齐；TD-J 循环检测；TD-K LISTEN/NOTIFY；Lesson 可见性域（ADR + 实现）；OCC 冲突归因（ADR + 实现）；A2A 评估 +（视评估结果）最小桥；`same_as` 身份归一化；Trail 引用（agent B 经 `memex_retrieve` 引用 agent A 的历史 Trail——08 的 CCR 检索路径复用）。

**Out of scope：**
- 信任分级的**工具集映射执行** → Phase 14（本阶段只在 AgentCard 定 `trust_level` 字段与取值枚举）
- 自动身份合并建议（Trail Discovery 统计发现同一人）→ post-1.0；本阶段 `same_as` 由用户/管理员显式建立
- Federated Trail Mesh（跨实例）→ post-1.0
- TD-L（Pi 沙箱 OCC 预演）→ 可选项：仅当本阶段集成测试实测 OCC 冲突率 >5% 才启动，否则记录数据后继续推迟

## 4. DoR — 进入规划的就绪条件

- [ ] Phase 10 DoD（Lesson/强化闭环在跑——共享记忆有内容可共享；指标通路可查历史成功率）
- [ ] Phase 12 DoD G5（跨平台续接——身份归一化的前置语料）+ `sender_id` 前缀已全渠道生效
- [ ] TD-I 粒度决策在 discuss 第一个议题拍板（阻塞多候选路由的一切设计）
- [ ] A2A 规范现状短报告完成（§2g）
- [ ] 与 Phase 14 的互锁确认：`trust_level` 取值枚举两阶段共用一份定义，写在 `@graph/types/core`，本阶段定形、14 阶段消费

## 5. DoD — 完成定义（可观测门）

| # | 门 | 验证方式 |
|---|---|---|
| G1 | 多候选路由：两个 agent 声明同一粗类目 → 按 trust_level+历史成功率选择；细标签存在时重排生效 | 路由测试 |
| G2 | TD-J：构造 A→B→A 委托环 → `ERR_CYCLE_DETECTED`，无僵尸等待 | 环夹具测试 |
| G3 | TD-K：wait_all_tasks 完成通知延迟 <500ms（vs 轮询的 0–2s）；超时返回形状不变（向后兼容） | 延迟测试 + 回归 |
| G4 | delegation：并发子 agent 数被 cap；子 Scope conflict 事件在父 Scope 的 Knapsack 高权重层可见 | 集成测试 |
| G5 | 可见性域安全门：agent X 的 private Lesson 在 agent Y 的 reflect 结果中**绝不出现**（含 BM25 与 HNSW 两路）；shared 命中触发强化 | 安全测试（红线） |
| G6 | OCC 冲突归因：两 agent 对同一 Entity 矛盾写入 → 冲突事件含双方 principal → 进高权重层 | 集成测试 |
| G7 | `same_as`：建立别名后，另一渠道消息自动续接同一 principal 的进行中 Scope | E2E |
| G8 | A2A：按评估结论交付（最小桥互通测试，或接口预留 + 评估报告归档） | 视评估 |
| G9 | 三个新 ADR 归档；全量测试 + tsc；implementation-notes 更新 | CI + 人工核对 |

## 6. 前向铺路契约

1. **`trust_level` 枚举定形**（§4 互锁）：Phase 14 的"信任级别 → 工具集映射"只填映射表，不改类型。
2. **冲突归因事件是 Phase 14 审计语料**："这个 agent 总在尝试越权/总在制造冲突"的涌现信号，14 的安全事件分析直接消费。
3. **可见性域是 post-1.0 Federated Mesh 的前置**：域过滤逻辑封装为单一函数（`visibilityFilter(principal)`），跨实例扩展时改这一处。
4. **principal 模型统一**（user/worker/external agent 同为图上 Entity）：Phase 14 的 per-principal 工具白名单、审批流的"谁在请求"全部建立在这个模型上——本阶段把它做实，14 不再碰身份建模。

## 7. 风险与开放问题

- **可见性域的检索性能**：HNSW 部分索引不能按动态 principal 过滤——过滤只能后置（先 ANN 再过滤），召回数需要补偿放大（Top-20 → Top-40 再过滤）。规划时纳入 reflect 预算测试。
- **A2A 规范成熟度**是本阶段最大外部不确定性——评估先行的设计就是为了把它隔离成可推迟项，不让它阻塞其余交付物。
- **历史成功率的冷启动**：新 agent 无历史 → 排序退化为 trust_level 单信号。可接受（新 agent 本来就该从低信任开始），在路由 ADR 中显式声明。

---
*Phase 链：10（指标通路）+ 12（身份语料/续接）→ **13** → 14（trust_level 消费、审计语料、principal 模型）、post-1.0（Federated Mesh）*
