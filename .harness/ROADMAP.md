# Roadmap

## 北极星（愿景级，非阶段）

**最终产品形态：基于 MemexCore 构建一个 Hermes-agent 级别的端到端系统**——用户多次确认这是长期目标（2026-06-08）。Hermes 在这里是"交互模式与产品形态"的参照对象，不是要照搬其实现。

### MemexOS 三层架构（2026-06-09 锁定）

| 层 | 名称 | 内容 | 状态 |
|---|---|---|---|
| 产品品牌 | **MemexOS** | MemexCore + MemexShell 合称，不是独立代码层 | 命名锁定 |
| 核心运行时 | **MemexCore** | iii-engine、PostgreSQL 账本、Workers、Control Plane、Gateway HTTP（含 MCP server） | 现存，相对稳定 |
| 交互与集成层 | **MemexShell** | MemexTerminal、Dashboard 前端、onboarding TUI、packages/cli、packages/pi-extension | 后期主战场 |

**MemexShell 设计原则**：Shell 不拥有状态，所有状态在 Core 的 Graph 里。Shell 是 Gateway REST API 的纯客户端。Shell 变，Core 不动。

**如何应用**：规划新功能时优先问"这属于 MemexCore 的 API 扩展，还是 MemexShell 的新组件"。当前各阶段（05/06）仍聚焦 MemexCore 扩展，MemexShell 主体（MemexTerminal、Dashboard）是后续阶段。

### MemexShell 已确认组件

- **MemexTerminal**：内置默认 TUI，用 Pi SDK 构建（`createAgentSession` + `subscribe`）；调 Gateway REST API；安装后自动启动。Pi SDK 是实现技术，不是身份标签。与外部 Pi Terminal（MCP peer agent）语义完全不同。
- **Dashboard**：独立前端，Gateway REST 轮询（历史快照，非实时流）；图可视化（workflow 涌现、节点详情）在 Dashboard 而非 MemexTerminal。
- **Onboarding TUI**（`@clack/prompts`）：首次安装引导，配置 LLM provider；写入独立 config 文件（非 graph，非 .env）；与 ADR-22 worker 侧 `LLMProvider` 是不同层面，通过 config 文件衔接。
- **packages/cli**（connect 工具）、**packages/pi-extension**（外部 Pi Terminal 集成 artifact）。

### MCP Inspector（开发测试工具，非产品组件）

`npx @modelcontextprotocol/inspector` 用于 MCP server 完整测试，不是 MemexShell 组件。

## 01-discuss

Domain model finalization, terminology alignment, RFC ratification.

## 02-plan

Architecture planning, data model design, API contracts, ADRs.

## 03-execute

Implementation: PostgreSQL schema, event bus, agent runtime, hash chain.

## 04-external-integrations

MCP gateway, Claude Code + Pi Terminal connect CLI, distributed locking, memory crystallization. ✅ Complete.

## 04-plugs（Phase 5 前置）

Phase 5 执行前的结构性补丁：LLM provider 抽象层 SOLID 重构（`LLMApi` / `LLMProviderConfig` / `createLLMProvider()`，Pi SDK 命名对齐）+ Phase 5 T2 CommandGate 完整 54 pattern 参考（含 hermes→graph-runtime 适配）+ Phase 5 T3 阈值穿越检测 AC 修正。见 `.harness/phases/04-plugs/04-plugs-PLAN.md`。

## 05-provider-safety

Multi-provider LLM abstraction (Anthropic adapter), CommandGate safety module, agentskills.io skill export, webhook notification delivery.

## 06-extensions

MCP client (inbound tool consumption), execute_bash MCP tool, messaging gateway (Telegram + Discord), UserProfileWorker, cryptographic agent pairing. ⚠️ T6 "graph inspection TUI" 已重新定位：graph 可视化属于 MemexShell Dashboard（非独立 TUI）；MemexTerminal 是唯一 TUI 入口，属于后续 MemexShell 阶段，不在 Phase 6 范围。

---

## 未来架构改进方向（Phase 7+，待转化为 ADR / Phase Plan）

> 来源：nanobot 对比分析 + 用户确认（2026-06-09）。以下各项尚未安排具体阶段，规划时需写 ADR 或 phase plan。

### 1. LLM Provider 多提供商注册表（ADR-22 扩展）

**现状：** `OpenAICompatibleProvider` 已覆盖 Ollama / vLLM / DeepSeek / LM Studio 等 OpenAI 兼容接口。`AnthropicProvider` Phase 5 T1 补充。

**待规划：**
- **Provider 注册表**：通过 config 文件声明多个 provider（id、type、apiBase、apiKey）；Worker 按 `LLM_PROVIDER` 名称查找，不需要修改代码即可切换。参考：nanobot `providers/registry.py` 模式。
- **FallbackProvider（电路熔断）**：主 provider 失败后自动切换。错误分类：`timeout / rate_limit / overloaded` → failover；`auth / context_length / content_filter` → 直接报错不 failover。参考：nanobot `fallback_provider.py`。
- **本地 LLM 一等支持**：Ollama / vLLM / LM Studio 明确文档化配置路径（`apiBase` 指向本地端口）。

### 2. WebSocket / SSE 实时 API（新 ADR 待写）

**现状：** Gateway 是纯 REST。Dashboard 使用 REST polling（历史快照）。

**待决策：**
- MemexTerminal 实时 agent event stream（tool_execution_start、text_delta）需要 WebSocket 或 SSE。
- Dashboard 实时推送（新 Trail 写入通知）同上。
- 两者可以共用一个 event stream endpoint，也可以分开。
- 参考：nanobot WebSocket channel（`channels/websocket/` → `/ws` 端点，WebUI 直连）。
- **影响：** Gateway package 加 WS handler；Shell 层订阅方式确定后，Dashboard 和 MemexTerminal 都受益。

### 3. Types 集中管理（架构决策待写）

**现状：** 类型定义分散在各 package（`@graph/shared`、`@graph/gateway`、`@graph/workers`）。

**待规划：**
- 新建 `packages/types`（`@graph/types`）：Core 类型（`Entity`、`HyperEdge`、`Scope`、`Lesson`、`Trail`）集中定义，其他 package 只 import，不重新定义。
- **三层分工：**
  - `@graph/types/core`：iii-engine / Ledger 层类型（不依赖任何 package）
  - `@graph/types/api`：Gateway REST + WebSocket contract types（request / response schema）
  - `@graph/types/shell`：MemexShell 消费类型（Dashboard state、MemexTerminal session）
- **Pi SDK 对齐：** `packages/pi-extension` 和 MemexTerminal 的类型继承 Pi SDK 官方 `AgentSession`、`ToolResult`、`Message` 等 interface，不重新定义等价类型。Gateway REST response shapes 设计时参考 Pi SDK 期望的输入格式。

### 4. 全局 config.json（配置层分层设计待写）

**现状：** `iii-config.yaml` 只覆盖 Core 层（Worker LLMProvider 注入、iii-engine 配置）。

**待规划：**
- 系统级 `~/.memex/config.json`（参考 nanobot `~/.nanobot/config.json`）：
  - Gateway 端口、TLS 设置
  - Channel tokens（Telegram、Discord）
  - LLM provider 注册表（apiKey 通过 `${ENV_VAR}` 引用，不硬编码）
  - Dashboard 和 MemexTerminal 连接地址
  - WebSocket 开关
- **配置层分工（锁定）：**
  - `iii-config.yaml` → MemexCore：Worker LLMProvider 注入、iii-engine 参数
  - `~/.memex/config.json` → 全系统：Shell + Gateway + channel + provider 注册表
- **env var 引用：** `"apiKey": "${ANTHROPIC_API_KEY}"` 在 startup 时从环境变量解析，解析值不写回磁盘。

### 5. SKILL.md 生态兼容扩展（Phase 5 T3 基础）

Phase 5 T3 已加入 `requires.bins / requires.env / always` frontmatter 字段（nanobot 格式）。

**后续扩展：**
- **Progressive loading**：Dashboard / MemexTerminal 展示技能列表时，先加载 `name + description`，按需获取全文（减少 token 消耗）。参考：nanobot `build_skills_summary()` + `load_skills_for_context()` 两阶段策略。
- **ClawHub 格式兼容**：agentskills.io 和 ClawHub 两个 registry 共享同一 frontmatter schema，导出的 SKILL.md 可直接发布到任一 registry。

### 6. CrystallizeWorker "外科式蒸馏"原则（nanobot Dream 借鉴）

**参考：** nanobot Dream 的设计哲学——不重写整个记忆文件，而是做"最小诚实变更"。

**待应用：** 同一 `fingerprint_id` 的 Lesson 多次强化（Ebbinghaus reinforcement）时，CrystallizeWorker 的 LLM prompt 应识别已有 Lesson 内容，只追加新 insight，不重复已有要点。避免每次强化都覆盖全文。实现方式：prompt 中注入 `existing_lesson_content`，要求 LLM 输出 delta 而非全量重写。

---

## 技术债清偿轨道（2026-06-11 盘点，编入 Phase 09–15）

> 来源：`.harness/implementation-notes.md`、`docs/OPEN_ISSUES_TRACKING.md`、`09/11-DESIGN-NOTES.md`、代码内 TODO。
> 原则：每项债务编入"它自然属于的阶段"——该阶段的交付物本来就要触碰这块代码，顺势清偿，不另设独立的"还债阶段"。各项已同步写入对应阶段的核心交付物。

| # | 债务 | 来源 | 清偿阶段 | 理由 |
|---|---|---|---|---|
| TD-A | 记忆表缺 ADR-43 provenance 列 | ADR-43 D-4 | **09** ✅ 已编入 plan（migration 012 含 `source_scope_id`+`erased_at`） | 建表时机唯一 |
| TD-B | Working Memory 无时间窗口去重（P1-F，原"Phase 2 补入"未做）——高频工具调用语义重复，污染 Knapsack token 预算 | 追踪表 P1-F / ADR-11 | **10** | Phase 10 调 Knapsack 权重反馈，去重是同一条 token 效率线 |
| TD-C | `template_graph` 为非结构化 LLM JSON，模式涌现不可机器比对（G2） | 追踪表 G2 | **10** | TemplateProposalWorker 完整版定稿前必须锁定 edge-list 格式，否则 Trail Discovery 命中率不可测 |
| TD-D | ADR-20 文档欠账：强化 SQL（P1-D）、归纳触发频率（P2-D）、衰减调度（P2-E） | 追踪表 | **10** | 三项全是 Phase 10 强化闭环的实现内容，实现即归档 |
| TD-E | `dispatchMessage` 每条消息新建 Scope——会话上下文不在图中累积（Phase 6 MVP 限制） | implementation-notes | **11** | MemexTerminal 持久会话直接踩此坑；Phase 12 跨平台会话连续性以此为前置 |
| TD-F | `pi-extension` fetch 仍是 stub（返回 mode/args） | 代码 TODO | **11** | Phase 11 交付物 #7 本来就要发布 pi-extension |
| TD-G | Pairing：明文 in-memory Map、无 rate limit/lockout、重启即失效 | implementation-notes / 11-NOTES §3 | **11**（hermes 六项加固 + DB 持久化）；跨副本同步 → **15** | Phase 11 WS/SSE ADR 已含本地认证，pairing 是同一个 ADR 的范围 |
| TD-H | Gateway 独立 `gatewayLlmProvider` 绕过 `createLLMProvider()` 路由 | implementation-notes | **11** | Provider 注册表落地时统一收编 |
| TD-I | AgentCard skill 粒度未定（P1-G，Phase 3 占位的粗粒度词表） | 追踪表 P1-G | **13** | 多候选竞争路由必须先定粒度标准 |
| TD-J | FrontierScheduler 无循环依赖检测（P1-H，仅靠 TTL+watchdog 兜底） | 追踪表 P1-H | **13** | 内部 delegation 嵌套 Trail 使循环风险实质化 |
| TD-K | `wait_all_tasks` 2 秒轮询而非 LISTEN/NOTIFY | implementation-notes | **13** | 多 agent 并发等待时轮询延迟与 DB 压力放大 |
| TD-L | Pi 沙箱预演（P1-B，OCC 预检，原"Phase 4 优化"未做） | 追踪表 P1-B | **13**（可选项） | 多 agent OCC 冲突率上升后才有收益，先观测再决定 |
| TD-M | Gateway 依赖 Bun 运行时（与 Workers 的 Node 22 双运行时） | TECH_STACK §6 | **15** | 安装脚本/Docker 镜像必须显式处理双运行时 |

未编入项：CommandGate tier-3 LLM 审批（已在 Phase 14 #2）、env 两段式过滤（已在 Phase 14 #3）、G1 遍历代数（post-1.0 候选，无阻塞证据）。

**Phase Spec（2026-06-11）：** Phase 09–14 各有一份 `​.planning/phases/<NN-name>/<NN>-PHASE-SPEC.md`——含设计要点、范围、DoR、DoD、前向铺路契约。**各阶段 discuss/planning 启动时必读**；DoR/DoD 跨阶段互锁（每阶段 DoR 引用上一阶段 DoD 门），前向契约条款是下一阶段 DoR 的核查清单。

---

## 08-context-assembly

**目标：** 将 Knapsack Slicing（ADR-13）从规格落地为可运行代码，并补充 CCR 可逆压缩路径，替代 ADR-13 补充中 Level-3 的"熔断挂起"硬截断。

**背景：** ADR-13 规定了 Knapsack Slicing 算法的规格（前驱哈希链 + token 预算裁剪），但目前系统没有任何实现——Worker 获取的 context 是未经裁剪的完整链路。随着 Scope 增长，这将成为 OOM 和 LLM 性能的主要瓶颈。

### 核心交付物

1. **Knapsack Slicing 算法实现**（`@graph/workers` 上下文组装层）
   - 沿前驱哈希链逆向追溯，按 token 权重（recency × importance）装包
   - 重要性分层：`conflict_detected` / `scope_closed` 节点权重最高；稳定的 `memory_updated` 序列可聚合
   - 参考：headroom `SmartCrusher` 的变点检测（`change_points`）+ 常量提取策略（`headroom/transforms/smart_crusher.py`）

2. **CCR 可逆压缩路径**（ADR-13 Level-3 的替代方案）
   - 当前驱链超出 W_max 时，不直接熔断挂起，而是压缩低优先级节点并缓存原始内容
   - Worker 的 system prompt 注入检索工具：`memex_retrieve(hash)` —— Worker 认为需要完整数据时主动调用
   - CCR hash 作为 `_meta` 字段写入 context，不污染图账本
   - 参考：headroom `ccr/tool_injection.py`、`ccr/response_handler.py`

3. **Wasm Tokenizer 集成**（ADR-15）
   - `@dqbd/tiktoken` 精确 token 计数用于 Knapsack 装包决策和 CCR 触发阈值
   - 复用已有 tokenizer 基础设施，补充 `countTokens(node)` 工具函数

4. **Pipeline lifecycle hooks**（Worker 扩展点）
   - 参考 headroom `hooks.py` 的 `on_pipeline_event(stage, data)` 模式
   - 定义 Worker 生命周期的可观测事件点：`context_assembled`、`context_compressed`、`llm_called`、`result_written`
   - 为 Phase 09 的记忆注入（Reflection Track）预留插槽

**与现有 ADR 的关系：** ADR-13 + ADR-13 补充（CCR 替代 Level-3）；ADR-15（Wasm Tokenizer）；ADR-22（LLM 调用接口）。

**前置条件：** Phase 07-architecture 完成（MemoryRepository seam、graph-handle 整合已就位）。

---

## 09-memory-layers

**目标：** 实现四层记忆中尚未落地的三层：Episodic、Semantic、Procedural。Working Memory（`execution_event_log`）已在 Phase 03 完成，本阶段补齐剩余三层及其检索路径。

**背景：** RFC §8 定义了四层记忆的完整架构，但 Phase 03–07 仅实现了 Working Memory。CrystallizeWorker 和 LessonSaveWorker 已在 Phase 04 完成，但 Episodic / Semantic / Procedural 三张表尚未创建，Lesson 只写入了占位表。

### 核心交付物

1. **Episodic Memory 写入**（`scope_closed` 触发）
   - `episodic_memory` 表：HNSW 向量索引 + 时序索引
   - TemplateProposalWorker 雏形：读取 Scope 完整 DAG → 提取意图摘要 + 结果摘要 → 写入 episodic

2. **Semantic Memory + supersession chains**
   - `semantic_memory` 表：`superseded_by` 自引用外键 + 部分 HNSW 索引（`WHERE superseded_by IS NULL`）
   - `supersede()` 操作：新版本写入时链接旧版本，旧版本从检索空间排除（不物理删除）
   - LLM 触发合并 hint：相似度 > 0.89 时返回"建议合并"而非强制覆盖
   - 参考：headroom `memory/` 的 supersession 实现细节（`valid_from` / `valid_until` 时间戳对）

3. **Procedural Memory 基础**（`is_anti_pattern` 双 HNSW 分区）
   - `procedural_memory` 表：正负样本双独立 HNSW 部分索引
   - 基础写入路径：TemplateProposalWorker 提取骨架写正样本，orphan node 写负样本

4. **BM25 + HNSW RRF 混合检索**（ADR-20 规格落地）
   - `ts_doc` GIN 全文索引 + `pgvector` HNSW 余弦相似度
   - Reciprocal Rank Fusion（RRF k=60）合并两路结果
   - Reflection Track 触发接口（`mem::reflect`，ADR-21 规格）

**与现有 ADR 的关系：** ADR-20（混合检索）；ADR-21（Reflection Track 触发规格）；ADR-22（Embedding Provider）；**ADR-43（数据删除权，2026-06-11 新增）——三张记忆表建表即带 `source_scope_id` provenance 列 + `erased_at`，embedding 随行级联删除**。这是 ADR-43 唯一阻塞本阶段的约束，加密机制本身推迟到 Phase 14。

**前置条件：** Phase 08-context-assembly 完成（Pipeline lifecycle hooks 中 Reflection Track 插槽已预留）。

**Plans:** 4 plans

Plans:
- [x] 09-01-PLAN.md — Foundation seams: migration 012, MemoryRepository extensions, TrailReader.getScopeEvents, Worker.shouldReflect
- [x] 09-02-PLAN.md — TemplateProposalWorker: replaces EpisodicMemoryWorker, full DAG read, episodic write with embedding + orphan anti-pattern writes
- [x] 09-03-PLAN.md — SemanticMemoryWorker supersession: embedding write path, suggestedMerge hint, supersede
- [x] 09-04-PLAN.md — reflect.function.ts hybrid search + cold_start wiring in assemble.ts + processAgentTurn.ts (production path) + index.ts boot wiring + EpisodicMemoryWorker deletion + pulse-fetch.ts episodic trigger cleanup

---

## 10-trail-discovery

**目标：** 实现 Trail Discovery（工作流涌现）——从历史 Scope 中自动提取可复用的执行模式，写入 Procedural Memory，使系统"越用越聪明"。同时完成 Ebbinghaus reinforcement 闭环和 CrystallizeWorker 外科式蒸馏优化。

**背景：** 这是 Memex 最核心的差异化能力。Phase 09 完成了 Procedural Memory 的基础写入，Phase 10 建立完整的涌现闭环：正负样本 → 骨架模板 → 冷启动注入 → 强化/衰减 → 蒸馏更新。

### 核心交付物

1. **TemplateProposalWorker（完整版）**
   - 被 `scope_closed` 触发，启动独立 Context Window
   - **正样本**：识别低冲突、短耗时收敛路径 → 提取抽象接口边骨架 → 写 `procedural_memory(is_anti_pattern=FALSE)`
   - **负样本（success correlation）**：追溯 orphan node 之后的收敛路径 → "失败→修正"因果对打包 → 写 `is_anti_pattern=TRUE`
   - 参考：headroom `cli/learn.py` 的 success correlation 逻辑（失败后做了什么修正才成功）

2. **Skeleton Graph 冷启动注入**
   - 新 Scope 冷启动时：嵌入向量 → Top-20 ANN → 三信号重排 → 拍入黄金骨架
   - 反面程序记忆并行注入 System Prompt（"禁止重蹈的坑"）

3. **PatternDiscoveryWorker**（ADR-25 跨域拓扑算法）
   - 定期扫描 Trail Mesh，提取跨 Scope 的通用拓扑结构
   - 更新 `semantic_memory` 跨域知识（如 "explore → hypothesize → validate → converge" 普适模式）

4. **Ebbinghaus reinforcement 闭环**
   - `success_count` / `reinforcement_count` 更新路径：Scope 再次命中某 Lesson → `+1` → 检索权重提升
   - 30 天衰减周期：`last_used_at` 配合衰减扫描（`graph::memory::decay` 定时触发）
   - **反馈驱动调参**：参考 headroom `compression_feedback.py` 的 `retrieval_rate → suggested_items` 模式，将 Lesson 的命中率映射到 Knapsack 中的 token 分配权重

5. **CrystallizeWorker 外科式蒸馏**（ROADMAP Phase 7+ item #6 落地）
   - 同一 `fingerprint_id` 多次强化时，prompt 注入 `existing_lesson_content`
   - LLM 输出 delta 而非全量重写，避免每次强化覆盖已有要点

6. **技术债清偿（TD-B / TD-C / TD-D）**
   - **TD-C（本阶段质量门）**：`template_graph` 锁定为结构化 edge-list 格式（节点 = event_type 标签，边 = 抽象接口边），TemplateProposalWorker 的 LLM prompt 输出受 schema 约束——两次对同构 DAG 的提取必须机器可比对，否则 Phase 16 的"Trail Discovery 命中率"指标无法成立。写入 ADR-25 补充。
   - **TD-B**：Working Memory 时间窗口去重（`SHA256(scope_id|entity_id|event_type|payload_hash)` + 5 分钟窗口，不含 predecessor_hash），拦截不同前驱下的语义重复工具调用——直接减少 Knapsack 装包的无效 token。写入 ADR-11 补充。
   - **TD-D**：ADR-20 文档欠账随实现归档——强化 SQL（P1-D）、Memory Synthesizer 双触发策略（P2-D：每日 02:00 cron + ≥20 条 episodic 事件触发）、Ebbinghaus 衰减扫描调度（P2-E：每日 03:00，`reinforcement_count=0 AND last_used_at < NOW()-'90 days'` → 逻辑删除）。

**与现有 ADR 的关系：** ADR-25（跨域拓扑算法 + template_graph 格式补充）；ADR-39（Pattern Discovery 调度）；ADR-36（Knowledge Entity 写时机）；ADR-11（去重窗口补充）；ADR-20（强化/归纳/衰减操作规范归档）。

**前置条件：** Phase 09-memory-layers 完成（Episodic + Procedural 表已就位，BM25+HNSW 检索可用）。

---

## 11-memex-shell

**目标：** 在 MemexCore 稳定基础上构建交互与集成层（MemexShell）。交付实时事件流 API、MemexTerminal TUI、Dashboard 前端、Onboarding TUI 及配套基础设施，使 MemexOS 具备完整的人机交互界面。

**背景：** Phase 08–10 完成 MemexCore 全部核心能力（Knapsack+CCR、四层记忆、Trail Discovery + Ebbinghaus 强化）。MemexShell 在 MemexCore 之上构建，严格遵循已锁定的设计原则：Shell 不拥有状态，所有状态在 Core 的 Graph 里；Shell 是 Gateway REST/WS 的纯客户端；Shell 变，Core 不动。Phase 6 T6"graph inspection TUI"已明确延至本阶段，不再在 Core 阶段实现。

**落地内容：** 本阶段同时落地 ROADMAP "未来架构改进方向" 中尚未执行的 #1–5 项（Provider 注册表、WSS/SSE、@graph/types、全局 config.json、SKILL.md progressive loading），这些项均是 MemexShell 的直接前置或内在组成部分。

### 核心交付物

1. **Gateway 实时事件流 API**（ROADMAP 未来改进方向 #2，新 ADR 待写）
   - **双轨设计**：SSE（单向推送）供 Dashboard 订阅 Trail 写入通知；WebSocket（双向）供 MemexTerminal 的 agent turn 交互流
   - SSE endpoint（`GET /events`）：scope 事件、Trail 新增、memory 更新通知；无状态、HTTP/2 兼容
   - WebSocket endpoint（`/ws`）：MemexTerminal agent session stream（`tool_execution_start`、`text_delta`、`scope_closed` 等）；参考 nanobot `channels/websocket/` 模式
   - Gateway package 新增 WS/SSE handler；现有 REST 路由不变（Shell 升级到 WS，不影响 Core API 消费方）

2. **`@graph/types` 统一类型包**（ROADMAP 未来改进方向 #3，新架构决策待写）
   - 新建 `packages/types`（`@graph/types`）：三层分工——`core`（Entity/HyperEdge/Scope/Lesson/Trail，无依赖）、`api`（Gateway REST + WS contract types）、`shell`（Dashboard state、MemexTerminal session）
   - Pi SDK 对齐：MemexTerminal 的会话类型继承 Pi SDK 官方 `AgentSession`/`ToolResult`/`Message` interface，不重新定义等价类型
   - 其他 package 迁移为只 import `@graph/types`，不保留内部重复定义

3. **全局 `~/.memex/config.json`**（ROADMAP 未来改进方向 #4）
   - 内容：Gateway 端口 / TLS、Channel tokens（Telegram/Discord）、LLM provider 注册表（apiKey 用 `${ENV_VAR}` 引用，不硬编码）、Dashboard 和 MemexTerminal 连接地址、WebSocket 开关
   - 配置层分工最终落地：`iii-config.yaml` → MemexCore（Worker LLMProvider 注入、iii-engine 参数）；`~/.memex/config.json` → 全系统（Shell + Gateway + channel + provider 注册表）
   - Startup 时展开环境变量引用，解析值不写回磁盘

4. **MemexTerminal TUI**
   - 技术：Pi SDK（`createAgentSession` + `subscribe`），连接 `/ws` WebSocket endpoint
   - 纯 Gateway 客户端——零状态所有权；安装后自动启动
   - SKILL.md 两阶段加载（ROADMAP 未来改进方向 #5）：列表显示仅加载 `name + description`，按需拉取全文；参考 nanobot `build_skills_summary()` / `load_skills_for_context()` 模式
   - 不含图可视化（归属 Dashboard）；不含 Trail Discovery 结果展示（归属 Dashboard）

5. **Onboarding TUI**（`@clack/prompts`）
   - 首次安装引导：检测 LLM provider、配置 apiKey、选择 Gateway 端口，写入 `~/.memex/config.json`
   - LLM Provider 注册表初始化（ROADMAP 未来改进方向 #1 落地）：引导配置多 provider（Anthropic / OpenAI compatible / Ollama）及 FallbackProvider 策略
   - 无 graph 写入——纯 config 文件操作，与 ADR-22 Worker 侧 `LLMProvider` 通过 config 文件衔接

6. **Dashboard 前端**
   - **图可视化**（Phase 6 T6 延迟至此）：workflow 涌现图（Trail Mesh 拓扑）、节点详情（Entity / HyperEdge / Lesson inspect）
   - SSE 订阅实时 Trail 写入通知（依赖交付物 #1）；历史快照视图保留 REST polling
   - SKILL.md 两阶段加载（同 MemexTerminal，复用同一 loader 实现）
   - Trail Discovery 结果展示：Phase 10 产出的 Procedural Memory 骨架模板可视化

7. **`packages/cli` connect 工具 + `packages/pi-extension`**
   - `packages/cli`：`memex connect` 命令，将外部 Pi Terminal 连接到本地 Gateway（认证、地址绑定）
   - `packages/pi-extension`：发布到外部 Pi Terminal 客户端的集成 artifact；类型继承 `@graph/types/shell`；**清偿 TD-F**——补齐 stub fetch（`src/index.ts` 现仍返回 mode/args，未接真实 Gateway 调用）

8. **技术债清偿（Phase 6 遗留：TD-E / TD-G / TD-H）**
   - **TD-E（本阶段关键路径）**：修复 `dispatchMessage` 每条消息 `randomUUID()` 新建 Scope 的 MVP 限制——同一 `sessionKey` 映射到稳定 Scope（经 `nestScope()`），会话上下文在图中累积。MemexTerminal 持久会话依赖此项；**Phase 12 跨平台会话连续性以此为硬前置**。
   - **TD-G**：Pairing 加固到 hermes 六项标准（code 加盐哈希存储、无歧义字母表、rate limit、失败 lockout、constant-time 比较、文件权限）+ 从 in-memory Map 迁移 DB 持久化（重启不失效）。归入本阶段 WS/SSE ADR 的本地认证章节，同一个 ADR 写完。跨副本同步推迟到 Phase 15。
   - **TD-H**：Gateway 的独立 `gatewayLlmProvider`（直接 new `OpenAICompatibleProvider`）收编进 `createLLMProvider()` / provider 注册表路由——注册表落地后系统内不允许第二条 provider 构造路径。

### 与现有 ADR 的关系

- 新 ADR 待写：WSS/SSE 实时 API 设计（endpoint 契约、事件类型枚举、背压策略、**本地客户端认证**——默认 bind localhost 为底线，Dashboard/MemexTerminal 连接 token 机制、**端点限速**）
- 新架构决策待写：`@graph/types` 三层分工、迁移策略
- ADR-22（LLM Provider 抽象）：Onboarding TUI 的 Provider 注册表是 ADR-22 的 config-layer 落地
- ADR-24（Agent Entry Point Protocol）：MemexTerminal 的 `createAgentSession` 调用路径须符合 ADR-24 入口契约

**前置条件：** Phase 10-trail-discovery 完成（Ebbinghaus 强化闭环建立，Procedural Memory 可视化有内容可展示）；Phase 08 Pipeline hooks 已就位（WS 事件流的 emit 点依赖 `onLLMCalled`/`onResultWritten` 钩子）。

---

# 产品化弧线（Phase 12–16，2026-06-11 规划）

> 来源：hermes-agent 深度研究报告（`.harness/analysis/hermes-agent-deep-research-report.md`）+ Phase 11 设计笔记（`.planning/phases/11-memex-shell/11-DESIGN-NOTES.md`）中明确推迟的项 + 标本目录映射。
> 北极星不变：基于 MemexCore 构建 Hermes-agent 级别的端到端系统（MemexOS）。Phase 08–11 完成"引擎 + 交互层"；Phase 12–16 完成"产品"。

**用户目标 → 阶段映射：**

| 产品目标 | 阶段 | 一句话 |
|---|---|---|
| 多终端集成 | **12-connector-matrix** | Connector 矩阵 + graph-native 定时任务 + 跨平台投递 |
| 内外多 agent 协作 | **13-agent-federation** | 内部 delegation + 外部 agent 联邦，经共享 Trail Mesh 协作 |
| 可对外开放的信任边界 | **14-trust-isolation** | 执行沙箱、跨渠道审批流、secrets 管理（开放部署的前置门） |
| 一键部署、多环境 | **15-deploy-everywhere** | install 一行命令、Docker compose、doctor、profiles、远程 Gateway |
| 完整产品 1.0 | **16-memexos-one** | Skill 生态双向、E2E 验收、文档与发布管道 |

**排序原理：** 12–13 在自托管单租户前提下扩展能力面；14 在"任何人都能装"（15）之前完成安全硬化——这是 hermes 自身演进顺序的复刻（先功能后 SECURITY.md 信任模型成文）。16 是质量门收口。

---

## 12-connector-matrix

**目标：** 把 MemexOS 从"两个聊天机器人"（Telegram/Discord，Phase 6）扩展为"任意终端皆可触达的常驻系统"：声明式 Connector 注册表、更多渠道、graph-native 定时任务、跨平台结果投递。

**背景：** Phase 11 交付 ConnectorAdapter interface 与 MemexTerminal/Dashboard 两个一等客户端，但渠道矩阵和调度能力被明确推迟（11-DESIGN-NOTES "不采纳的点"：cron 需要 Phase 9/10 Trail Mesh 完全就位——届时已满足）。

### 核心交付物

1. **ConnectorRegistry 声明式注册表**（参考 hermes `gateway/platform_registry.py` 的 `PlatformEntry` 模式）
   - 每个 Connector 注册元数据：`check_fn`（依赖检测）、`validate_config`、`required_env`、`standalone_sender_fn`（无 live gateway 时的投递路径）、`platform_hint`（注入 system prompt 的平台上下文）
   - 现有 Telegram/Discord bot 迁移到注册表；Dashboard "已连接渠道"状态面板直接消费元数据
   - **Memex 差异化**：Connector 配置变更写图（`connector::config_updated` Association），变更历史可被 Trail Discovery 分析（11-DESIGN-NOTES §1 预留项落地）

2. **新增渠道**：Slack（Socket Mode，无入站端口）、Email（IMAP 轮询 + SMTP）、入站 Webhook（受限工具集，见 Phase 14 交叉引用；**入站签名校验必配**——HMAC secret，hermes Telegram webhook `secret_token` 模式）
   - 入站消息统一归一化为 MessageEvent（参考 hermes `gateway/platforms/base.py`）
   - `sender_id` 一律带渠道前缀（`telegram:12345678`），为 Phase 13 跨渠道身份归一化预留（11-DESIGN-NOTES §5）

3. **Graph-native Cron**（参考 hermes `cron/scheduler.py`，但 job 存图不存 jobs.json）
   - 定时任务 = 图上的 Entity（schedule、prompt、deliver、origin 字段）；每次触发创建新 Scope，运行即一条 Trail
   - **Memex 差异化**：定时任务的历史运行可被 Trail Discovery 学习（"这个周报任务每次都在同一步骤偏离"是信号）
   - tick 调度复用 iii-engine durable subscriber，不另起独立 scheduler 进程

4. **DeliveryRouter**（参考 hermes `gateway/delivery.py` + `cron/scheduler.py` 投递目标解析）
   - deliver 目标语法：`origin` / `<platform>`（home channel）/ `<platform>:<chat_id>` / `all` / 逗号组合
   - home channel 配置入 `~/.memex/config.json`（Phase 11 已建立）；静默输出抑制（silence marker 不投递）

5. **跨平台会话连续性**（相对 hermes 的结构性优势，本阶段验收亮点）
   - **硬前置：Phase 11 TD-E 已修复**（`dispatchMessage` 稳定 session→Scope 映射）——否则"同一条 Trail 的延续"无从谈起
   - hermes 的 session 是 platform-scoped，明确不支持跨平台合并；Memex 的状态在 Graph——同一用户从 Telegram 发起、在 MemexTerminal 继续、在 Dashboard 查看，天然是同一条 Trail 的延续
   - 验收场景：Telegram 创建任务 → MemexTerminal 接续对话（上下文经 Knapsack 组装自同一 Scope）→ 结果按 origin 投递回 Telegram

**与现有 ADR 的关系：** ADR-24（Agent Entry Point Protocol，所有渠道入口统一走此契约）；Phase 11 WS/SSE ADR（Connector 事件如何进事件流）；新 ADR 待写：Cron Entity schema 与触发语义。

**前置条件：** Phase 11 完成（ConnectorAdapter interface、config.json、DeliveryRouter 的投递端依赖 Gateway 实时 API）。

---

## 13-agent-federation

**目标：** 内部 sub-agent delegation + 外部 agent 联邦，全部经由共享 Trail Mesh 协作——agent 之间不直接对话，通过图协作。这是 Memex 对"multi-agent 框架"的范式回答：没有编排层，协作模式从共享 Trail 中涌现。

**背景：** Phase 6 已交付 MCP peer 接入（AgentCard、pairing、FrontierScheduler skill 路由）。本阶段把"单 agent + 外挂工具"升级为"多 agent 共享一张图"。

### 核心交付物

1. **内部 delegation**（参考 hermes `delegation.*`：`max_concurrent_children`、子 agent 模型 override）
   - Worker 可派生 sub-scope agent（`sub-scope-result.worker` 已有基础），并发上限可配，结果汇聚回父 Trail
   - 子 agent 的完整执行是嵌套 Trail——父 Scope 可见子 Scope 的偏离与冲突，不只是最终结果

2. **外部 agent 联邦**
   - AgentCard 扩展：capability/skill 声明、信任级别（与 Phase 14 信任分级衔接）
   - MCP peer（已有）保持；**A2A（Agent2Agent）协议适配评估 + 最小实现**——行业互操作方向，外部 agent 不装 Memex 也能以 A2A 语义参与协作
   - FrontierScheduler 多候选竞争路由：同一 skill 多个 agent 声明时按 AgentCard 信任级别 + 历史成功率（图上可查）选择

3. **Graph-mediated collaboration（核心差异化）**
   - 多 agent 写同一 Scope 的 OCC 语义（`occ-write` 已有基础，扩展冲突归因到 agent 身份）
   - conflict detection 跨 agent 生效：两个 agent 对同一 Entity 的矛盾写入是一等 Trail 数据，进入 Knapsack 高权重层
   - Trail 引用：agent B 可引用 agent A 的历史 Trail 作为上下文（经 `memex_retrieve` 检索路径）

4. **跨 agent 共享记忆**（headroom 学习方向 #5 落地）
   - Lesson 可见性域：`agent-private` / `shared` / `global`；CrystallizeWorker 蒸馏时标注归属
   - 外部 agent 命中 shared Lesson 同样触发 Ebbinghaus reinforcement——系统从所有参与者的使用中变聪明

5. **跨渠道身份归一化**（11-DESIGN-NOTES §5 推迟项落地）
   - 同一用户的多渠道身份 = 同一 Entity 的多个别名 Snapshot（`same_as` Association），不为每个渠道硬写归一化函数
   - 人和 agent 共用同一身份模型：user、internal worker、external agent 都是图上的 principal Entity

6. **技术债清偿（ADR-42 悬决项：TD-I / TD-J / TD-K；可选 TD-L）**
   - **TD-I（本阶段前置决策）**：AgentCard skill 粒度标准拍板（P1-G，Phase 3 起悬决）——多候选竞争路由（交付物 #2）无法在"粗粒度词表 + 未定标准"上构建。倾向：两级词表（粗类目 + 可选细标签），spawner 只需声明粗类目，细标签用于同类多候选间重排。随交付物 #2 的新 ADR 一并写入。
   - **TD-J**：FrontierScheduler 循环依赖检测落地（P1-H，ADR-42 D-6 的 `ERR_CYCLE_DETECTED`）——内部 delegation 的嵌套 Trail 使 `spawned_by` 环成为现实风险，TTL+watchdog 兜底产生的等待延迟在多 agent 场景不可接受。
   - **TD-K**：`wait_all_tasks` 从 2 秒轮询升级为 LISTEN/NOTIFY 聚合——Phase 3 因 stateless MCP transport 选了轮询；多 agent 并发汇聚（交付物 #1 的结果汇聚回父 Trail）使轮询的延迟与 DB 压力随 agent 数线性放大。
   - **TD-L（可选，先观测再决定）**：Pi 沙箱预演作 OCC 预检（P1-B）——仅当多 agent OCC 冲突率实测显著时启动，否则维持 YAGNI。

**与现有 ADR 的关系：** ADR-24（入口协议扩展到 A2A）；ADR-25（跨域拓扑——多 agent Trail 是最丰富的模式来源）；ADR-42（skill 粒度 + D-6 循环检测落地）；新 ADR 待写：Lesson 可见性域、A2A 适配层、多 agent OCC 冲突归因。

**前置条件：** Phase 10（Lesson/reinforcement 闭环——共享记忆有内容可共享）；Phase 12（身份前缀 `sender_id` 约定已就位）。

---

## 14-trust-isolation

**目标：** 把"个人自托管玩具"硬化为可对外开放的系统：执行隔离、跨渠道审批流、secrets 管理、外部 agent 信任分级。这是 Phase 15 一键部署的安全前置门——在"任何人都能装"之前完成。

**背景：** Phase 5 CommandGate（54 pattern）和 Phase 6 pairing 是单点防线。hermes SECURITY.md 的核心原则直接采纳："no in-process mechanism is a security boundary —— 只有 OS 级隔离构成真正的遏制"。

### 核心交付物

1. **执行后端抽象**（参考 hermes `tools/environments/`）
   - `execute_bash` 从 local-only 扩展为 local / docker 双后端；docker 后端：`--cap-drop ALL` + 最小 cap-add、`no-new-privileges`、`--pids-limit`、nosuid/noexec tmpfs（直接复刻 hermes `_BASE_SECURITY_ARGS`）
   - 容器内命令绕过审批（hermes 同款 rationale：容器内破坏性命令触不到宿主机）；orphan container reaper
   - 后端选择入 `~/.memex/config.json`；SSH/cloud 后端不做（YAGNI，记入 post-1.0 候选）

2. **跨渠道审批流**（参考 hermes gateway approval："Silence is not consent"）
   - 危险命令审批请求经 DeliveryRouter 推送到 home channel；用户 `/approve` `/deny`；超时即拒绝
   - 审批范围：once / session / always（always 写入 config allowlist）
   - CommandGate 三层结构对齐 hermes：硬线 blocklist（任何模式不可绕过）→ pattern 审批（YOLO 可绕过）→ 可选 aux-LLM smart approval

3. **Secrets 管理**
   - config.json env 引用展开已有（Phase 11）；补充：env denylist（`LD_PRELOAD`/`PYTHONPATH`/`PATH` 等永不可被写入，hermes `config.py:116` 模式）
   - subprocess env 两段式过滤（11-DESIGN-NOTES §4 附带任务正式落地）：`_SECRET_SUBSTRINGS` 黑名单 + `_SAFE_ENV_PREFIXES` 白名单

4. **外部 agent / 不可信来源信任分级**
   - pairing（已有）之上的 per-principal 工具白名单；入站 Webhook（Phase 12）默认 webhook-safe 受限工具集（hermes `_HERMES_WEBHOOK_SAFE_TOOLS` 模式：不可信第三方内容不得触达文件/命令执行工具）
   - AgentCard 信任级别 → 工具集映射，供 Phase 13 联邦消费

5. **Audit trail：安全事件入图**
   - 审批请求、批准、拒绝、blocklist 阻断都是 Association——安全历史可查询、可被 Trail Discovery 分析（"这个 agent 总在尝试越权"是涌现信号）

6. **数据安全**（ADR-43 落地 + 静态防护，2026-06-11 补充）
   - **Crypto-shredding 实现**（ADR-43 D-2 第二步）：payload 加密存储、per-Scope DEK + `key_registry`、`erase(scope)` 工作流（销毁 DEK + 派生数据级联删除 + `memex::payload::erase` 审计事件）
   - **静态加密**：Postgres 数据目录加密部署指引（Docker 卷加密 / 文件系统层），密文 payload 是第一层，盘加密是第二层
   - **PII 脱敏**（hermes `privacy.redact_pii` 模式）：发送给 LLM 前 + 写入账本前的已知 PII 模式脱敏；与 erasure 分工见 ADR-43 D-6（写入前防御 vs 事后救济）

**与现有 ADR 的关系：** Phase 5 CommandGate 规格（扩展为三层）；**ADR-43（数据删除权——本阶段实现其加密与 erase 工作流）**；新 ADR 待写：执行后端抽象、审批流协议（跨渠道异步审批的状态机）、信任分级模型。

**前置条件：** Phase 12（DeliveryRouter——审批流的推送通道）；Phase 13 可并行启动但其外部联邦开放依赖本阶段信任分级。

---

## 15-deploy-everywhere

**目标：** 任何人在任何主流环境一条命令起 MemexOS。安装、诊断、多环境隔离、服务化、远程访问、备份——产品的"外壳工程"。

**背景：** 当前部署 = 开发者手工：clone、pnpm install、Postgres 手配、env 手写。hermes 的安装矩阵（install.sh/install.ps1/Docker/Termux/Nix）是直接参照，但 Memex 多一个硬依赖：PostgreSQL（pgvector + pgcrypto）。

### 核心交付物

1. **一键安装脚本**（参考 hermes `scripts/install.sh` / `install.ps1`）
   - Linux/macOS/WSL2：`curl | bash`；Windows 原生：`iex (irm ...)`
   - 依赖检测与自动安置：Node 22、PostgreSQL（本机已有 → 复用；没有 → 引导 Docker 路径）；结束自动进入 Onboarding TUI（Phase 11 已建）
   - **TD-M**：Gateway 依赖 Bun、Workers 依赖 Node 22（TECH_STACK §6 双运行时）——安装脚本与 Docker 镜像必须显式安置两者，或在本阶段评估 Gateway 收敛到单运行时的成本（值变更 vs 类型变更：Hono 本身跨运行时，收敛可能比维护双依赖便宜，届时实测定）
   - 安装方式戳记（git/docker/npm），managed 模式下 onboarding 禁止改 config（hermes managed-install 模式）

2. **Docker 一键部署**
   - 单 `docker-compose.yml` = Postgres(pgvector) + MemexCore + Gateway + Dashboard；数据卷持久化 `~/.memex` + pgdata
   - 可选 hardened compose override：`internal`/`egress` 双网络 + proxy allowlist（hermes `network-egress-isolation.md` 直接复用，与 Phase 14 衔接）
   - Windows / macOS / Linux 三平台验证

3. **`memex doctor`**（参考 hermes `hermes_cli/doctor.py`，纯诊断不改配置）
   - 检查项：Postgres 连通 + pgvector/pgcrypto 扩展、hash chain 完整性抽查、LLM provider 连通性（逐 provider）、channel token 有效性、Gateway/服务存活、Node 版本一致性

4. **Profiles 多环境**（参考 hermes `~/.hermes/profiles/<name>` 完整隔离）
   - `~/.memex/profiles/<name>`：config 隔离 + 数据库维度隔离（per-profile database）；`MEMEX_PROFILE` env var；子进程显式传递避免写错 profile

5. **系统服务安装**：systemd（Linux）/ launchd（macOS）/ Scheduled Task（Windows）；开机自启 Gateway + Workers

6. **远程 Gateway / 跨机器连续性**
   - Shell（MemexTerminal/Dashboard/cli）连接远程 Core：TLS + token 认证；`memex connect` 扩展为支持远程地址
   - **TD-G 收尾**：pairing 跨副本同步（Phase 11 已做 DB 持久化，多副本部署场景在此补齐共享存储语义）
   - 一份 Graph 多机访问——办公室桌面与笔记本共享同一 Trail Mesh（落地长期存在的 cross-machine continuity 需求）

7. **备份与恢复**：`memex backup` / `memex restore`（pg_dump 包装）+ 恢复后 hash chain 校验；ledger 不可变性使增量备份天然可行
   - **备份加密约束（ADR-43 后果条款）**：备份加密密钥体系与 `key_registry` 同源，使"销毁 DEK"对备份同样生效；做不到则文档化"备份保留期 = 删除生效延迟"

**与现有 ADR 的关系：** 新 ADR 待写：部署拓扑（单机 all-in-one vs Core 远程 + Shell 本地）、profile 隔离边界。

**前置条件：** Phase 14 完成（对外开放安装的安全前置）；Phase 11 Onboarding TUI（安装脚本的收尾环节）。

---

## 16-memexos-one

**目标：** MemexOS 1.0 收口：skill 生态双向打通、端到端验收与 eval、文档与发布管道。"完整产品"的定义在此兑现。

### 核心交付物

1. **Skill 生态双向**
   - 导出已有（Phase 5 agentskills.io）；补充**安装侧**：`memex skills search/install/inspect`，安装前 skills-guard 注入模式扫描（hermes `skills_guard.py` 模式，明确定位"review aid 而非安全边界"）
   - agentskills.io / ClawHub 双 registry 兼容（ROADMAP 改进方向 #5 收尾）

2. **E2E 验收场景集 + eval harness**
   - UAT journey 固化为可重复脚本（`.harness/analysis/uat-journey-2026-06-07.md` 是雏形）
   - **Memex 特有质量指标**：Trail Discovery pattern 命中率、Lesson 留存率/强化率、Knapsack 压缩后任务成功率对比——"越用越聪明"必须可测量，不是口号
   - 回归门：每次发布前跑全量 journey + 指标不退化

3. **文档与发布管道**
   - Quickstart（一键安装 → 第一条 Trail 五分钟内）；架构文档从 ADR 提炼为用户视角文档
   - 版本化发布：changelog、git tag、Docker tag、install 脚本版本锁定
   - **发布完整性**：install 脚本与发布物 SHA-256 校验和 + 签名（hermes 下载 tirith 时的 checksum + cosign 验证模式，用在我们自己的发布管道上）
   - `memex --version` / doctor 集成更新检查（可选、不静默上报）

3b. **SECURITY.md 信任模型成文 + 漏洞披露政策**（hermes SECURITY.md 模式）
   - 明确"什么在范围内 / 什么不是安全边界"（in-process 机制不是边界、容器才是）；声明 ADR-43 的已知边界（多源 Lesson redistill 窗口期、备份保留期语义）
   - 漏洞披露渠道与响应承诺

4. **遥测（可选、本地优先）**：默认关闭；开启时仅聚合指标不含内容；自己的使用数据首先服务于自己的 Trail Discovery

**前置条件：** Phase 12–15 全部完成。

---

# 能力图（Capability Graph，2026-06-12 拍板，ADR-51）

> 来源：Fuller 会话七项拍板（2026-06-12），经 Agent Skills 官方规范 + MCP 官方规范 + agent-browser 实测三重交叉验证。完整决策见 `docs/adr/0060-adr51-capability-graph-schema.md`。
> 核心：能力（skill / MCP / connector / preset）统一为图上一等公民；meta tool = 操作能力图的工具族（`search_catalog` / `install` / `inspect`）。

| 决策 | 一句话 |
|---|---|
| 权威关系 | 图为语义权威；config 仅运维信息（连接/引导参数）；MCP 条目策略字段为期望态输入 |
| 节点粒度 | 三层 Category / Implementation / Tool；边按形态分型（`exposes`=MCP/worker tool，`consumes`=skill/CLI） |
| Tool 判别 | Tool Entity = 注册的可调用签名；CLI 子命令走 payload 投影，facade 注册后升格 |
| 选择权 | agent 在场内选；统计驱动 Level-1 注入排序；meta tool 仅在能力缺口时调用 |
| 背书机制 | 采样 → 场景条件化（episodic ANN）→ 注入排序 + 显式标注（反样本走反面程序记忆通道） |
| 归因 | 共现计数打底 + 切换因果对强样本（复用 Phase 10 success correlation） |
| 落点 | 分摊修订：17 最小增量、18 主体、20 消费——不设新阶段 |

---

## 17-mcp-connector-ecosystem ✅ Complete (2026-06-12, ADR-50)

**目标：** 补齐与 hermes-agent 对比后最大的剩余差距——MCP server 目录（catalog）、远程 MCP 的 OAuth PKCE + token 缓存、`memex mcp` CLI 管理命令。配置文件格式与机制必须兼容 Claude Code 的 `~/.claude.json` `mcpServers` JSON 形态与 Hermes 的 `mcp_servers` YAML 形态——用过两者之一的用户应能零上手成本识别并迁移现有配置；同时为后续 plugin 生态（model-providers / platform connectors / memory / web-search providers，参照 hermes `plugins/<category>/<name>/plugin.yaml`）预留可扩展的 manifest 结构，但不在本阶段实现。

**背景：** Phase 6 已交付 `McpClientWorker`（`packages/workers/src/integrations/mcp-client.worker.ts`）：仅 HTTP/Streamable transport，读取裸 `MCP_SERVER_URLS` env var，无目录、无鉴权、不分工具开关。Phase 16 G1 交付了 skills 安装侧（`memex skills search/install/inspect` + skills-guard 扫描，`packages/cli/src/skills.ts`），其 download→scan→write→confirm 流程是 MCP catalog install 的直接模板。MCP TypeScript SDK 已自带 `OAuthClientProvider` 接口（`@modelcontextprotocol/sdk` `client/auth.js`）且 `StreamableHTTPClientTransport` 接受 `authProvider` 选项，Block 2 不需要手搓 OAuth，只需实现一个持久化到磁盘的 provider 类。

### 核心交付物

1. **MCP Catalog（Block 1）**
   - 新增仓库内目录 `optional-mcps/<name>/manifest.yaml`（PR-gated，沿用 skills-guard 的"预审但可审查"信任模型）
   - manifest schema 设计为可无损映射到 Claude Code `mcpServers` JSON 条目与 Hermes `mcp_servers` YAML 条目的超集：
     ```yaml
     name: <id>
     description: <string>
     transport:
       # stdio
       command: <string>
       args: [<string>]
       env: {KEY: "${ENV_VAR}"}
       # 或 http/streamable
       url: <string>
       headers: {Authorization: "Bearer ${TOKEN}"}
       auth: oauth   # 触发 Block 2 流程
     requires_env: [<string>]      # 安装时若未设置则提示输入
     tools:
       default_enabled: [<tool 名称>]   # 对应 tools.include
     ```
   - 新增 `McpCatalogRegistry`（`packages/cli/src/mcp/catalog-registry.ts`），形状参照 `packages/gateway-bot/src/connectors/registry.ts` 的 `ConnectorRegistry`：`list()` / `get(name)` / `validateConfig()` / `statusReport()`（探测 `requires_env`）
   - `MemexConfigSchema`（`packages/shared/src/config/loader.ts`）新增可选 `mcp_servers: Record<string, McpServerEntrySchema>` 顶层字段（additive，向后兼容）。字段命名直接对齐 Claude Code / Hermes：stdio 用 `command`/`args`/`env`，HTTP 用 `url`/`headers`（对应 Claude Code `type: "http"`），`auth: "oauth"`，`tools: {include?, exclude?}`（对应 Hermes `tools.include`），`enabled: boolean`
   - `McpClientWorker` 扩展：
     - 除现有 `MCP_SERVER_URLS` 外，从 `loadMemexConfig()` 读取 `mcp_servers`（env var 仍兼容，降级为一条匿名条目）
     - 新增 **stdio transport** 支持（SDK 的 `StdioClientTransport`），按条目有 `command` 还是 `url` 选择 transport
     - 注册前按 `tools.include`/`tools.exclude` 过滤 `listTools()` 结果（当前是全量注册）。**ADR-51 定性**：include/exclude 是期望态输入（运维指令）；连接后实际生效的工具面作为观察写图
     - **能力图最小增量（ADR-51 D-7）**：`listTools()` 生效结果 + `notifications/tools/list_changed` 订阅 → `memex::capability::surface_changed` 事件入图；每个生效 tool 对应 Tool Entity（`exposes` 边），调用统计自动挂节点（既有 `graph::mcp-ext::*` 事件补一条到 Tool Entity 的引用）
     - 工具命名：保留现有 `graph::mcp-ext::<host>::<tool>`（沿用既有命名，按 CLAUDE.md 不强改既存标识符），但当条目来自 config/catalog 时允许用 catalog 名替代裸 host 作为命名空间段

2. **OAuth PKCE + token 缓存（Block 2）**
   - 新增 `packages/cli/src/mcp/oauth-provider.ts`：`MemexOAuthProvider implements OAuthClientProvider`（SDK 接口）——`tokens()`/`saveTokens()` 读写 `~/.memex/mcp-tokens/<server>.json`（0600 权限，对应 hermes `~/.hermes/mcp-tokens/<server>.json`），`clientInformation()`/`saveClientInformation()`、`codeVerifier()`/`saveCodeVerifier()`（PKCE）同样落盘缓存，`redirectUrl` 指向本地临时端口 `http://localhost:<port>/callback`
   - `redirectToAuthorization()`：打开系统浏览器（headless 环境打印 URL），与 hermes 的浏览器授权 UX 一致
   - `memex mcp login <name>`：调用 SDK 的 `auth(provider, {serverUrl})`，起一个临时本地 HTTP server 接收 redirect callback，完成 PKCE 交换并落盘 token
   - 当条目 `auth: oauth` 时，`McpClientWorker` 向 `StreamableHTTPClientTransport` 传入 `authProvider: new MemexOAuthProvider(serverName)`；token 刷新由 SDK 按其文档行为自动处理
   - token 缓存目录 `~/.memex/mcp-tokens/` 按 profile 隔离（`profileDir()` 之下）

3. **`memex mcp` CLI 命令族（Block 3）**
   - 新增 `packages/cli/src/mcp.ts`，从 `index.ts` 的 `KNOWN` 数组加入 `'mcp'`，沿用 `runSkillsCommand()` 的 dispatch 模式：
     - `memex mcp catalog` — 列出所有 `optional-mcps/*/manifest.yaml`，标注 enabled/installed 状态（对应 `hermes mcp`）
     - `memex mcp install <name>` — manifest 写入 `~/.memex/config.json` 的 `mcp_servers.<name>`（`@clack/prompts` 提示 `requires_env`，与 onboard.ts 一致）；安装前对 manifest 内容跑 skills-guard 扫描（复用 `scanSkillContent` —— 目录内容同样是"来自 registry 的内容"）；**同时写能力图**（ADR-51 D-7：Implementation Entity + `memex::capability::installed` Association；config 只承载 transport/env 运维字段）
     - `memex mcp configure <name>` — 重新提示 env vars + 工具 include/exclude 多选清单（对 `listTools()` 结果 multiselect，需要先尝试连接）
     - `memex mcp login <name>` — Block 2 OAuth 流程
     - `memex mcp list` — 列出已配置 server 及实时状态（connected/error）
     - `memex mcp uninstall <name>` — 从 config 移除并删除对应缓存 token

4. **主流配置兼容性（跨切面）**
   - `memex connect claude-code`（`packages/cli/src/connect/claude-code.ts`）扩展：完成 `graph-runtime` 写入 `~/.claude.json` `mcpServers` 后，可选地将 `~/.memex/config.json` 中已启用的 `mcp_servers` 条目同步镜像进 `~/.claude.json` 的 `mcpServers`（`--include-mcp-servers` 或交互提示）——已通过 `memex mcp install` 配置过的用户切到 Claude Code 时零重复配置
   - 新增 `docs/mcp-config-compat.md`：Memex `mcp_servers.<name>` ↔ Claude Code `mcpServers.<name>` ↔ Hermes `mcp_servers.<name>` 字段映射表，供两类用户对照

### 与现有 ADR 的关系
- 扩展 ADR-22（LLM Provider Abstraction）的声明式 registry 哲学到 MCP server registry（非 LLM provider，但相同的 registration 模式）
- 新 ADR-50：MCP Catalog Manifest Schema + OAuth Token Cache 设计（manifest 字段定义、token 文件权限/路径、stdio vs http transport 选择逻辑、tools include/exclude 语义）
- **ADR-51（能力图，已有骨架 `docs/adr/0060`）**：本阶段实现其 D-7 第 17 行——install 写能力 Entity、工具面观察入图；与 ADR-50 是姊妹关系（manifest 描述安装来源，ADR-51 定义安装后入图的形状）
- 复用 ADR-47（trust isolation）的 `isToolAllowed`：catalog 安装的 MCP 工具同样要过现有信任分级，`graph::mcp-ext::*` 不自动绕过

**前置条件：** Phase 16 完成（skills 安装侧 + skills-guard 已就位，本阶段直接复用其 download→scan→write 流程）；以 Phase 6 `McpClientWorker` 现状（HTTP-only、env-var 驱动）为扩展基线，不重写。

---

# 场景驱动弧线（Phase 18–20，2026-06-12 规划）

> 来源：三个 use-case scenario 差距分析（2026-06-12）——S1 WSL2 一键部署与首跑体验、S2 skills/MCP/artifact 生态、S3 自主个人助理。
> 排序原则：先让系统在真实环境里活起来（18），再补能力面与可视化（19），最后冲自主性（20）。S3 的每一项都需要活体部署来验证，本地 WSL2（Kali）是现成靶机。Phase 17 是 S2/S3 的 MCP 前置，保持为下一个阶段不变。

| 场景 | 阶段 | 一句话 |
|---|---|---|
| S1 一键部署 + onboarding + Terminal + Telegram | **18-first-run-experience** | 活体遗留清偿 + WSL2 一等支持 + onboarding 扩展 + 通用能力预设 |
| S2 artifact 展示 + skill 作用域 | **19-console-and-artifacts** | Artifact 写图约定 + UI-SPEC Console 完整版 |
| S3 自主助理（网球场故事） | **20-autonomous-assistant** | agent 自主能力获取 + ask_user + 凭据保险库 + 受控浏览器能力 |

---

## 18-first-run-experience ✅ Code-complete (2026-06-12; live-host runs remain — see implementation-notes)

**目标：** Scenario 1 整条走通：在一台真实 WSL2（Kali minimal）上从 `curl | bash` 到 Telegram 互发消息一气呵成。清偿 implementation-notes 活体验证遗留清单中阻塞首跑体验的项。

**背景：** Phase 15/16 的 install/journey 只过了容器化 E2E，真实主机 install 从未跑过（implementation-notes "three-platform install runs" 遗留）。Onboarding TUI 目前只配 LLM provider + gateway 端口；MemexTerminal 是 v1 readline REPL，Pi-SDK agent 模式是代码注释里写明的"下一个增量"。

### 核心交付物

1. **活体遗留清偿**（implementation-notes Phase 12/14/15 遗留项中阻塞首跑的部分）
   - 三平台 install 真机跑通（首选本地 WSL2 Kali 靶机；macOS/Linux 各至少一次）
   - docker exec 活体接线 + containment verification（`docker inspect` 核查 `--cap-drop ALL`/`no-new-privileges` 实际生效，Phase 14 遗留）
   - Email 生产绑定（imapflow/nodemailer，Phase 12 遗留）
   - iii version pinning（0.19.2 image vs 0.11.2 dev 的 scheduled trigger provider 差距）；service registration on real hosts

2. **WSL2 一等支持**
   - WSL 检测（`/proc/version` 含 microsoft）→ 用 `wslview`/`explorer.exe` 打开 Windows 浏览器访问 `localhost:<port>`（WSL2 localhost 转发默认开启）
   - systemd 检测与降级：未启用时打印 `/etc/wsl.conf` 启用指引而非失败
   - apt 路径依赖引导（Kali minimal 缺 curl/git/Node）；Docker Desktop 集成 vs 原生 docker-ce 检测，`memex doctor` 加检查项
   - **`/mnt/c` automount 风险文档化**：local 执行后端能触达 Windows 文件系统——部署指引指向 docker 后端或禁 automount

3. **Onboarding 扩展**（`packages/cli/src/onboard.ts`）
   - 结束时显示系统概况 summary（provider、端口、服务状态、下一步指引）
   - 自动打开 Dashboard（经 WSL 检测分支）；结束自动启动 MemexTerminal
   - **可选 Telegram 配对步骤**：bot token 录入 → 写 config → 启动 gateway-bot → pairing 握手（复用 Phase 11 加固后的 pairing）；跳过不阻塞

4. **通用能力预设（capability presets）**
   - **能力类目 → 推荐实现**的预设目录：browser → `vercel-labs/agent-browser`、search → Tavily 等；类目是稳定的，实现是用户可选可换的——一个类目可由 skill、MCP server 或 CLI 工具任一形态提供，目录条目声明其形态与安装方式
   - 目录机制复用既有件：skill 形态走 skills 安装侧（Phase 16，含 skills-guard 扫描）；MCP 形态走 `optional-mcps/` catalog（Phase 17）；CLI 工具形态在 manifest 里声明 `requires_bins` + 安装指引
   - Onboarding 增加可选 multiselect 步骤从预设目录挑选安装；后期插拔走同一路径（`memex skills` / `memex mcp` / 预设目录命令），onboarding 不是唯一入口
   - **Meta-skills 默认推荐随装**：`skills.sh` 工具 + find-skill / create-skill 等元能力——agent "自己找 skill 装上"（Phase 20 交付物 #1）的前提是 find-skill 先在系统里；这是 S3 自主性的用户侧铺路
   - **"类目→实现"绑定即图上 Snapshot 链**（ADR-51 D-1 修订，替代原"绑定写 config"方案）：绑定是能力图 Entity 的 `memex::capability::bound` Snapshot 链（当前绑定 = 最新 Snapshot），Worker 按类目解析读图；config 只存该实现所需的运维字段（env/key/bin 路径）
   - **能力图三层 schema 本阶段落地为主体**（ADR-51 D-2/D-7）：Category（presets 类目词表 = Category Entity 初始词表）/ Implementation（标注形态 skill/mcp/connector/cli）/ Tool 节点 + `provides`/`exposes`/`consumes`/`bound_to` 边；Level-1 metadata 注入按图上统计重排（背书 v1：共现计数归因，ADR-51 D-5/D-6）

5. **连接器事后配置路径**
   - `memex connect telegram`（CLI）：onboarding 时跳过配对的用户事后交互配置；复用 ConnectorRegistry 的 `validate_config`/`check_fn`
   - MemexTerminal 内 `/connect` 命令为可选增量（同一逻辑的 TUI 入口）

6. **MemexTerminal Pi-SDK agent 模式**（Phase 11 遗留的 documented next increment）
   - `createAgentSession` + `subscribe` 驱动真正的对话式交互；需要 live gateway + provider keys 验证——本阶段的活体部署正好提供该环境

**与现有 ADR 的关系：** ADR-48（部署拓扑）补 WSL2 附录；capability presets 的类目词表与"类目→实现"绑定 schema 已由 **ADR-51（能力图，骨架 `docs/adr/0060`）** 承载——本阶段是其 D-7 主体落地段，实装时把骨架补全为 accepted；其余为 Shell 层增量 + 活体验证。

**前置条件：** Phase 15/16 完成（install 脚本、Onboarding TUI、doctor 既有）。交付物 #4 的 MCP 形态条目依赖 Phase 17 catalog 机制（纯 skill/CLI 形态不依赖）；其余与 Phase 17 可并行。

---

## 19-console-and-artifacts

**目标：** 用户能在 Dashboard 里看到 Memex 的工作产出——artifact（文档、代码、research 结果）的写图约定 + UI-SPEC Console 完整版落地。同时拍板 skill 安装作用域。

**背景：** 完整 Console（Next.js + G6，`docs/UI-SPEC.md`）是 Phase 11 明确砍掉的遗留（现状是 gateway 内自包含 HTML live view v0）。更深一层：图里没有 "artifact" 概念——工作产出散落为事件 payload 和磁盘文件，没有"这是一个可展示交付物"的 Entity 约定，Console 没东西可渲染。

### 核心交付物

1. **Artifact 写图约定**（新 ADR）
   - Artifact = 图上的 Entity：`memex::artifact::created` / `memex::artifact::updated` Association；内容 SHA-256 寻址（与 Snapshot 哈希语义一致）
   - 大文件落盘（`~/.memex/artifacts/<hash>`），图存元数据 + 哈希引用——账本不膨胀，引用可校验
   - Worker 产出路径接入：execute_bash 产物、MCP 工具产物、research 汇总都可声明为 artifact
   - ADR-43 约束：artifact 随 `erase(scope)` 级联删除（provenance 列同款模式）

2. **Console 完整版**（UI-SPEC.md 设计基线，Next.js + G6）
   - 图可视化：Trail Mesh 拓扑、节点详情（Entity/HyperEdge/Lesson inspect）——Phase 6 T6 → Phase 11 → 本阶段的最终落点
   - Trail Discovery 结果展示：Procedural Memory 骨架模板可视化（Phase 10 产出）
   - **Artifact 预览**：markdown/code/HTML 渲染（交付物 #1 的消费端）；research 结果即 markdown artifact
   - Skills 面板：已安装 skill 列表 + 作用域标注（两阶段加载，复用 Phase 11 loader）
   - Gateway live view v0 保留为零安装 fallback，不删除

3. **Skill 安装作用域拍板**（S2 设计决策）
   - 现状只有全局安装；候选语义：global / per-profile（Phase 15 profiles）/ per-principal（与 Phase 13 Lesson 可见性域 agent-private/shared/global 同构）
   - 倾向：复用 Lesson 可见性域的三级模型，不发明第四套作用域词表；随交付物 #1 的 ADR 或独立短 ADR 写入
   - `memex skills install --scope <...>` 参数 + Console skills 面板展示

**与现有 ADR 的关系：** 新 ADR 待写：Artifact Entity schema（事件类型、哈希引用、落盘布局、erase 级联）；skill 作用域决策；ADR-43（erase 级联到 artifact）；UI-SPEC.md 是 Console 的设计基线文档。

**前置条件：** Phase 11 完成（SSE/WS 事件流、dashboard v0、UI-SPEC.md）；Phase 18 完成（活体部署使 Console 有真数据可看）非硬前置但强烈建议在前。

---

## 20-autonomous-assistant

**目标：** Scenario 3 核心能力：agent 自主获取能力（找 skill、装 skill、配置自己）、主动向用户求助、安全保存用户凭据、受控浏览器操作。"网球场预订故事"固化为北极星 E2E journey。

**背景：** 审批流（Phase 14）、信任分级（ADR-47）、执行后端抽象、DeliveryRouter（Phase 12）、会话连续性（TD-E）恰好都是为这类能力预留的接口——本阶段是组合现有件 + 三块新设计，不与现有架构冲突。浏览器自动化从 Post-1.0 提前，但限定为隔离执行后端内的 worker tool 形态（实现不绑定，见交付物 #4）。

### 核心交付物

1. **Agent 自主能力获取**
   - 用户侧入口是 Phase 18 随装的 find-skill / create-skill meta-skills；worker tool 层把 skills search/install 暴露给 agent（`memex::skill::search` / `memex::skill::install` 事件入图）
   - **经能力图统一**（ADR-51 D-4/D-7 消费段）：meta tool 动词族 = `search_catalog` / `install`（过审批）/ `inspect`，操作同一张能力图（skill/MCP/preset 三种来源同一查询面）；无 `select` 动词——运行时选择权在 agent（Level-1 注入排序已由 Phase 18 就位）
   - **背书机制 v2**（ADR-51 D-5/D-6）：切换因果对强样本（TemplateProposalWorker success correlation 加输出端）+ 显式标注注入（"相似任务中 X 成功 3 次；Y 上次在表单步骤偏离"，反样本走 Phase 10 反面程序记忆通道）
   - **agent 发起的安装必须过 Phase 14 审批流**：审批请求经 DeliveryRouter 推送 home channel，skills-guard 扫描结果注入审批请求正文，用户 `/approve` 后才落盘
   - Phase 17 的 `memex mcp install` 同样获得 agent 发起路径（同一审批协议）
   - 验收：agent 判断缺天气查询能力 → 搜到 skill → 发起审批 → 用户批准 → 安装配置 → 调用成功，全程一条 Trail

2. **`ask_user` 通用工具**
   - 泛化 Phase 14 审批流状态机：从"批准/拒绝二元"扩展为自由问答（提问经 DeliveryRouter 投递 origin/home channel，Scope 挂起等待回复，超时策略可配）
   - 回复接续同一 Scope（TD-E 稳定 session→Scope 映射已就位）；跨渠道提问/回答天然支持（Phase 12 会话连续性）
   - 问答对是一等 Trail 数据——"agent 总在同一步骤求助"是 Trail Discovery 信号

3. **凭据保险库**（per-service credential vault）
   - 复用 ADR-43 的 key_registry/crypto-shredding 机制：per-service DEK、密文落库、`erase` 语义覆盖
   - 写 LLM 前脱敏：凭据值进入 prompt 前替换为引用占位符（扩展 Phase 14 PII redaction 路径）；明文只在工具执行边界注入
   - 用户经 `ask_user` 提供凭据 → 脱敏入库 → 后续登录复用，不再询问

4. **受控浏览器能力**（Post-1.0 提前的限定形态；**实现不绑定**）
   - browser 是 capability 类目而非具体工具：实现由用户经 Phase 18 capability presets 安装的条目决定——`vercel-labs/agent-browser`（预设推荐）、Playwright 或其他 CLI 可控浏览器均可，Worker 按类目解析当前绑定
   - **不变量是隔离边界而非实现选型**：无论哪个实现，都跑在 docker 执行后端（`_BASE_SECURITY_ARGS` 同款隔离）内；明确**不控宿主浏览器**——宿主级 computer use 仍属 post-1.0
   - Worker 面工具签名统一（navigate / read / fill / click / screenshot），与底层实现解耦；截图可声明为 artifact（Phase 19 约定）
   - 登录态 session 持久化限容器卷内，凭据经交付物 #3 注入

5. **北极星 E2E journey：网球场预订故事**
   - 固化为 eval journey 脚本（mock 外部端点）：缺能力识别 → 自主装 skill（审批）→ 查天气 → 查 Calendar（Phase 17 MCP）→ `ask_user` 确认时段 → 浏览器预订 → origin 通知 → email 归档（cron）
   - **背书验收点**（ADR-51）：journey 二跑时验证能力图背书生效——首跑积累的 (场景, 能力, 结局) 样本使二跑的 Level-1 注入排序/标注可观察地不同（"越用越聪明"延伸到能力选择维度，与 Phase 16 的 Trail Discovery 命中率同族指标）
   - 接入 Phase 16 回归门：发布前必跑

6. **SECURITY.md 补章**
   - agent 发起安装为何必须人审（"agent 不能给自己授权"）；凭据保险库边界（什么进保险库、什么永不进 LLM context）；浏览器 tool 的容器边界声明
   - 延续 Phase 14"先安全后开放"顺序：本节成文是交付物 #1/#3/#4 对外启用的门

**与现有 ADR 的关系：** 新 ADR 待写：自主能力获取审批协议（状态机、超时、审批范围 once/session/always 复用）、凭据保险库 schema、browser tool 隔离边界。复用：ADR-47（信任分级——agent 发起的工具调用不绕过 `isToolAllowed`；**能力图统计与背书不构成授权**，ADR-51）、ADR-43（凭据 erase）、ADR-51（能力图——本阶段是其消费段，browser facade 注册时 CLI 子命令投影统计升格为 facade Tool 节点统计，D-3）、Phase 14 审批流与执行后端抽象。

**前置条件：** Phase 17 完成（Calendar/Gmail MCP + OAuth——journey 的日历环节）；Phase 18 完成（活体部署环境——本阶段全部能力需活体验证）；Phase 19 非硬前置（截图 artifact 展示降级为日志即可）。

---

## Post-1.0 方向（顺应 AI 发展，不排期、不写 ADR）

> 记录于此防止丢失，每项启动前需独立 scoping。

- **多模态 I/O**：voice channel（STT/TTS provider 抽象可仿 ADR-22 的 LLM provider 模式）、图像输入经 vision 辅助模型路由（hermes `image_routing` 模式）
- **Computer use / browser automation** 作为 worker tool（执行后端抽象已为其预留隔离语义）——容器化受控浏览器能力（实现经 capability presets 可选：agent-browser / Playwright 等）已提前至 Phase 20；此处保留的是宿主级 computer use（控制宿主浏览器/桌面）
- **本地模型深化**：Ollama/vLLM 一等支持已在 provider 注册表；补充本地 embedding 路径使全栈可离线
- **Federated Trail Mesh**：多实例图同步、社区共享 procedural patterns——Bush "shared trails" 的终极形态；前置是 Lesson 可见性域（Phase 13）的跨实例扩展
- **编辑器集成**（ACP 协议，hermes `hermes acp` 模式）：Memex 作为 IDE 内 agent 的记忆与 trail 后端
- **SSH / cloud 执行后端**（Modal/Daytona 类）：Phase 14 明确 YAGNI 推迟的项
