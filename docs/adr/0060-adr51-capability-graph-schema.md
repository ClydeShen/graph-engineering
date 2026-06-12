# ADR 51｜能力图（Capability Graph）：功能拓扑的图原生表示与背书机制

status: accepted（2026-06-12 Fuller 会话七项拍板；Phase 17 最小增量 + Phase 18 主体已落地——`packages/shared/src/capability/{graph,presets}.ts`、migration 017、`memex capability` CLI、cold-start 背书注入 `process-agent-turn.ts`；Phase 20 消费段待做）
日期: 2026-06-12

---

## 上下文

系统的"能力"散布在四种形态、四套注册表中：Skill（agentskills.io + skills-guard，Phase 5/16）、MCP server（`optional-mcps/` catalog，Phase 17）、Connector（ConnectorRegistry，Phase 12）、Capability preset（类目→实现绑定，Phase 18 计划）。Trail（执行历史）已经是图，但能力本身不是——能力之间的依赖、绑定、调用统计、组合关系没有统一的图表示。这导致两个缺口：

1. **agent 的能力选择是无记忆的**：多个同类能力（如多个 browser 实现）并存时，agent 只靠 description 语义匹配触发，不知道"上次这种场景用 X 成功了、用 Y 翻车了"。
2. **Phase 20 自主能力获取缺基座**：agent 自主搜索/安装/选择能力，需要一张可导航的"能力图"，而非四套互不联通的注册表。

本 ADR 把能力统一为图上的一等公民（capability-as-graph），meta tool = 操作这张能力图的工具族。

**官方规范交叉验证（2026-06-12）**：

- **Agent Skills 规范**（agentskills.io + Anthropic 官方文档）：Skill = 指令包，frontmatter 无 tool 声明字段；`allowed-tools` 方向是"Skill 被预批准使用的工具"。Skill 不暴露 tool，只消费 tool。发现机制 = `name + description` 语义匹配，无类目概念。
- **MCP 规范**（modelcontextprotocol.io）：协议中不存在"配置文件"概念；工具面经 `tools/list` 运行时发现，且是动态的（`notifications/tools/list_changed`）。`mcpServers` JSON 是客户端连接约定，非协议。**工具面是活的，只能被运行时观察**——这从原理上排除了 config 作为拓扑权威的可能。
- **agent-browser 实测**（vercel-labs）：skill+CLI 捆绑形态；其 SKILL.md 是 discovery stub，运行时拉取与二进制版本同步的指令——skill 形态的能力面同样是活的。

## 决策

### D-1：权威关系——图为语义权威，config 仅运维信息

能力的存在、类目绑定、工具面、统计全部以图为权威账本（观察式：安装/绑定/调用/成败均为 Association）。`~/.memex/config.json` 只保留"让系统跑起来"的运维信息：端口、API key、model name、transport 连接参数（command/args/env/url/headers）。**config 中不出现任何影响 Graph 主权的语义状态。**

精确切分（MCP 兼容约束下的唯一例外）：`mcp_servers` 条目中的 `tools: {include, exclude}` 与 `enabled` 是策略字段，因 Claude Code / Hermes 格式兼容（Phase 17 硬目标）保留在 config，但定性为**期望态输入**——连接后实际生效的工具面（`tools/list` 结果 × 过滤）作为观察写图。图记录"工具面是什么、何时变过"，config 只是产生它的运维指令。

类目→实现绑定无外部兼容约束，是 Memex 原生概念：**绑定本身是图上 Entity 的 Snapshot 链**（当前绑定 = 最新 Snapshot），Worker 解析类目读图，不读 config。

### D-2：节点粒度——三层 Category / Implementation / Tool，边按形态分型

| 层 | 定义 | 示例 |
|---|---|---|
| **Category** | 稳定的能力类目词表（Memex 自有发明，官方规范无此概念；与 description 语义检索并存而非取代） | browser、search、calendar |
| **Implementation** | 一个可安装的能力包，标注形态（skill / mcp / connector / cli / 捆绑） | agent-browser（skill+cli）、某 MCP server |
| **Tool** | 系统注册的可调用签名（见 D-3 判别原则） | `graph::mcp-ext::<host>::<tool>`、worker tool |

边（Association）类型：

- `provides`：Implementation → Category
- `bound_to`：Category → Implementation（绑定 Snapshot 链，D-1）
- `exposes`：Implementation → Tool——**仅 MCP server 与 worker tool 形态成立**（官方 Skill 规范验证：skill 不暴露 tool）
- `consumes`：Implementation → Tool（skill / CLI 形态：skill 消费 `execute_bash` 等；manifest `requires_bins` 声明）

与 ADR-42 TD-I 两级词表判例同构：Category = 粗类目，Tool = 细粒度承担重排。

### D-3：Tool Entity 判别原则与投影原则

**Tool Entity = 系统注册的可调用签名**——有 schema、出现在 agent 工具面上（MCP `tools/list` 结果、worker tool、未来的 category facade）。

CLI 子命令（如 `agent-browser open` / `click`）**不建 Tool 节点**：agent 实际调用的 tool 是 `execute_bash`，子命令集非封闭（无 `tools/list` 等价物，`eval`/`batch` 参数空间无界）。为不可枚举表面建节点违反账本纪律。

**投影原则**：子命令级统计经 bash 事件 payload 投影聚合（指标走列/投影、非账本实体——系统既有做法），不预建节点。当 Phase 20 facade 把 navigate/click 等注册为统一 worker tool 签名时，统计自然升格挂到 facade Tool 节点——投影先行，节点随注册而生。

### D-4：运行时选择权——agent 在场内选，统计驱动注入排序

能力图的 Level-1 metadata（name + description + 类目）按图上统计重排后注入冷启动 context（Phase 10 骨架注入同款路径）；agent 自己判断用哪个。meta tool 只在"场内没有合适能力"时被调用去搜目录——核心动词族：`search_catalog` / `install`（过审批）/ `inspect`，**不需要 `select`**。

理由：与官方渐进披露同构（Level-1 常驻是 Anthropic 实测设计）；与 Memex 范式一致（系统提供 proven structures，agent 保留偏离自由）。自动化体现在"注入的候选越来越准"，而非"替 agent 做决定"。特例：用户把某类目锁死为单一实现时，等价于自动路由。

### D-5：背书机制——采样 → 场景条件化 → 注入

Memex 为"多个同类能力中触发哪一个"提供背书，分三段，每段复用既有基础设施：

1. **采样**：Scope 激活了哪个能力 + 该 Trail 的结局（低冲突收敛 / orphan / 偏离）本就是账本一等数据。
2. **场景条件化**：背书不是全局成功率，而是**条件于当前场景的**——新 Scope 冷启动 → episodic embedding ANN 找相似历史 Scope（Phase 09/10 既有）→ 看那些 Scope 里同类能力的成败分布。
3. **注入**：遵守 D-4——背书改变注入的证据而非替 agent 选。两种力度：**排序**（Level-1 metadata 按场景条件成功率重排）+ **显式标注**（"相似任务中 X 成功 3 次；Y 上次在表单步骤偏离"——反样本走 Phase 10 反面程序记忆注入通道）。

Bush 原始隐喻的直接落地：**trail 本身就是背书**——前人走过且走通的路径，在路口处可见。

### D-6：归因——共现计数打底 + 切换因果对强样本

Scope 结局记到能力头上（credit assignment）采用分层：

- **共现归因（全量、便宜）**：Scope 结局记到该 Scope 激活过的所有能力——事件计数，立刻有数据；噪声由场景条件化（D-5.2）稀释。
- **切换因果对（强样本、高权重）**：沿 Trail 结构定位"激活 Y 后偏离 → 换用 X 后收敛"的切换对——复用 TemplateProposalWorker 的失败→修正提取逻辑（Phase 10 success correlation）加一个输出端。
- 排序信号 = 强样本优先、共现兜底。防"陪跑沾光"系统性偏差（最常随装的 meta-skill 霸榜）。

与 TD-L 同款判断风格：先观测再加严。

### D-7：落点——分摊修订，不设新阶段

与 ROADMAP 技术债编入原则同构（"每项编入它自然属于的阶段，顺势清偿"）：

| 阶段 | 能力图增量 |
|---|---|
| **17** | 最小增量：`memex mcp install` 同时写能力 Entity + Association；`tools/list` 生效工具面 + `list_changed` 订阅作为观察入图（`memex::capability::surface_changed`）；config 策略字段定性为期望态输入 |
| **18** | 主体：三层节点 schema 落地；绑定 Snapshot 链替代"绑定写 config"；presets 类目词表 = Category 初始词表；Level-1 注入排序（背书 v1：共现计数） |
| **20** | 消费：agent 自主获取经能力图（meta tool 动词族 + 审批）；切换因果对强样本 + 显式标注进北极星 journey 验收 |

新事件类型按 CLAUDE.md 命名规约使用 `memex::` 前缀（如 `memex::capability::installed` / `::bound` / `::surface_changed`）；既有 `graph::mcp-ext::*` 命名按"不强改既存标识符"原则保留。

## 与现有 ADR 的关系

- **ADR-50**（MCP Catalog Manifest Schema，Phase 17 待写）：姊妹 ADR——manifest 是 Implementation 节点的安装来源描述；本 ADR 定义安装后入图的形状
- **ADR-42 / TD-I**：两级词表判例（粗类目 + 细标签）是 D-2 三层粒度的直接前驱
- **ADR-47**（trust isolation）：能力图不改变 `isToolAllowed` 语义——图上的统计与背书不构成授权；agent 发起的安装仍过 Phase 14 审批流
- **ADR-25 / Phase 10**：背书的注入通道（骨架注入 + 反面程序记忆）与归因的提取逻辑（success correlation）全部复用
- **ADR-43**：能力 Entity 的 provenance 与 erase 级联遵循同款模式（待 Phase 17 实装时确认细节）
- **ADR-22**：声明式 registry 哲学的图原生延伸

## 后果

- 四套注册表（skill / MCP / connector / preset）获得统一的图表示；meta tool（`search_catalog` / `install` / `inspect`）操作同一张图
- agent 的能力选择从"无记忆的 description 匹配"升级为"场景条件化的 trail 背书"——系统"越用越聪明"延伸到能力选择维度
- config.json 的边界获得明确判据：运维信息（连接/引导）留 config，语义状态（绑定/工具面/统计）入图
- Phase 17 若按原文执行会再造 config-only 注册表、事后回填——本 ADR 先行避免返工
- 开放问题（实装时决）：能力 Entity 的 erase 级联细节；切换因果对的 schema（写 procedural memory 还是独立关联表）；Category 词表的治理（谁能加类目）
