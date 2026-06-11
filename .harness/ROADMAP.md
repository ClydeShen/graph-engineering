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

> 来源：`.harness/implementation-notes.md`、`docs/未决问题追踪.md`、`09/11-DESIGN-NOTES.md`、代码内 TODO。
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

## Post-1.0 方向（顺应 AI 发展，不排期、不写 ADR）

> 记录于此防止丢失，每项启动前需独立 scoping。

- **多模态 I/O**：voice channel（STT/TTS provider 抽象可仿 ADR-22 的 LLM provider 模式）、图像输入经 vision 辅助模型路由（hermes `image_routing` 模式）
- **Computer use / browser automation** 作为 worker tool（执行后端抽象已为其预留隔离语义）
- **本地模型深化**：Ollama/vLLM 一等支持已在 provider 注册表；补充本地 embedding 路径使全栈可离线
- **Federated Trail Mesh**：多实例图同步、社区共享 procedural patterns——Bush "shared trails" 的终极形态；前置是 Lesson 可见性域（Phase 13）的跨实例扩展
- **编辑器集成**（ACP 协议，hermes `hermes acp` 模式）：Memex 作为 IDE 内 agent 的记忆与 trail 后端
- **SSH / cloud 执行后端**（Modal/Daytona 类）：Phase 14 明确 YAGNI 推迟的项
