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
