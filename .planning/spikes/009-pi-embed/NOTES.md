# Spike 009 — MemexTerminal = Pi SDK 库内嵌（R-A + C3）

落点: ADR-57（`docs/adr/0066-adr57-memexterminal-pi-embed.md`）/ GH #25 / ROADMAP §23
分支: `feat/memexterminal-pi-embed`
日期: 2026-06-15

## 决议（fuller 会话）

- **R-A 库内嵌**：MemexTerminal = 基于 Pi 的进程,in-process import MemexCore 函数,不走 MCP。
- **C3 图为工作记忆**：每 turn 从图投影注入 Pi,turn 末冲回账本;Pi 持有的 message
  list 从不是权威状态。保住「Graph → Context」在 terminal 也成立。
- **脑** = Core onboarded provider 经 `streamSimple` 同进程委托（免 key/渠道一致）。
- **审批** = `tool_call` hook → `ctx.ui.confirm` 双写 `ApprovalService`。

## Pi 能力 — ctx7 docs 全绿（`/earendil-works/pi`）

| 需求 | Pi 原语 | 状态 |
|---|---|---|
| 借 Core 脑 | `registerProvider({streamSimple})` / `{baseUrl, api:"openai-completions"}` | ✅ |
| 绑 Core 工具 | `registerTool({async execute(id,params,signal,onUpdate,ctx)})` | ✅ |
| 每轮注入投影 | `on("before_agent_start")` → `{messages, systemPrompt}` | ✅ |
| 整轮冲回 | `on("turn_end")` → `event.message, event.toolResults` | ✅ |
| 审批插播 | `on("tool_call")` + `ctx.ui.confirm/select/input` | ✅ |

## 包谱系 — npm 实测（关键集成发现）

- `@earendil-works/pi` → **404,不存在**（docs 里的 `pi` 是 coding-agent 层的对象,非包名）
- `@earendil-works/pi-coding-agent` v0.79.3 — **嵌入目标**。desc: "Coding agent CLI with
  **read, bash, edit, write tools and session management**"（= 用户三目标:产代码/系统
  工具/管 session,自带）。`main: ./dist/index.js` + `exports`(含 .d.ts) → **有程序化入口**。`bin: { pi }`。
- `@earendil-works/pi-agent-core` v0.79.3 — "transport abstraction, state management"。更
  底层 loop,若 coding-agent 扩展面不够再下沉。
- `@earendil-works/pi-ai` v0.79.3 — provider 层（streamSimple/registerProvider 源）。
  deps: openai/anthropic/genai/mistral/bedrock + http(s)-proxy-agent。
- `@earendil-works/pi-tui` v0.79.3 — 差分渲染 TUI 库。

## Tracer bullet — 下一步（未开始写码）

**kill-criterion**: 钉死 `before_agent_start` 触发粒度 = **per-user-prompt**（用户发新
消息才重投影,内部工具循环 turn 不重投影）。若 per-internal-turn → C3 注入策略要改。

1. 隔离安装：standalone spike dir 自带 package.json 装 `@earendil-works/pi-coding-agent`
   （**不**塞进 monorepo workspace,避免扰动在跑的栈;装完读真 `.d.ts` 校对 docs API）。
2. `registerProvider("memex", {streamSimple})` → 先接 **stub LLM**（回固定串）验流式通,
   再换 Core 的 `LLMProvider`。
3. `registerTool` 绑 **1 个**最简 Core 工具（如图写 / `query_context`）。
4. `on("before_agent_start")` 注入一段假投影字符串 + log turnIndex/触发时机 → **验粒度**。
5. `on("turn_end")` → log message/toolResults（冲回 occWrite 的料是否够）。
6. `on("tool_call")` → `ctx.ui.confirm` 跑一次。
7. 跑一轮,确认 1→6 端到端 + kill-criterion。绿 = 留作地基,转量产切片。

## Tracer 结果（2026-06-15,`tracer.mjs` 实跑绿）

真 API 已核实（读 `dist/**/*.d.ts`,非 docs）:
- 嵌入入口 = `createAgentSession({ noTools, customTools, sessionManager, model, modelRegistry })`
  → `{ session: AgentSession }`(`core/sdk.ts`,有 `@example` 程序化用法)。
- 驱动 = `session.prompt(text)` / `session.subscribe(listener)`。
- 工具 = `defineTool({name,parameters:Type.Object,async execute(id,params)})` + `customTools[]`。
- hook = `ExtensionAPI.on("before_agent_start"|"turn_start"|"turn_end"|"tool_call"|
  "before_provider_request"|"agent_end"…)`(`extensions/types.d.ts`),in-process 注册
  走 `loadExtensionFromFactory`。

**kill-criterion = 双绿（类型 + 活体）**:
- `BeforeAgentStartEvent` 注释逐字 "Fired after user submits prompt but before agent loop"
  → **per-user-prompt**。`agent_end` 带 `messages[]` 亦 per-prompt。`turn_start/turn_end`
  带 `turnIndex` = per-internal-turn。
- `tracer.mjs` 实跑事件序列:`agent_start → turn_start → message_start/end ×2 → turn_end
  → agent_end`(一条 prompt)。agent_* 括住整条 prompt,turn_* 是内部轮。**确认**。

**ADR-57 精修（据活体）**:
- 注入点 = extension `before_agent_start` handler(不在 `session.subscribe` 流里——它是
  extension-runner 事件)；冲回点 = `agent_end`(per-prompt,含整轮 `messages[]`),比
  `turn_end` 干净;`turn_end` 留作细粒度 trail。
- `createAgentSession` 无 model/key 也跑完一轮(有默认兜底)——provider 接入是 build-out
  的事,非阻塞。

## Build-out line #1 — provider 接线（2026-06-15,机制+设计解完）

**设计纠正(实读 Core 接口)**:Core 的 `LLMProvider` = `chat(messages)→string`（+ Core
自有形状 `chatTurn`,见 `provider.interface.ts`）,**非流式、非 OpenAI 协议**。Pi 的 loop
要 provider 说 pi-ai 原生流式 + 原生 tool-calling。**in-process 委托(原 D-2)会让 Pi
丧失原生 tool-calling → 否决**。正解 = **config-share**:Core 配置 `{api,model,baseUrl,
apiKey}`（`from-config.ts` buildOne）→ pi 的 ModelRegistry,Pi 直连同一 endpoint。

**实测 Core 配置** = nvidia / `qwen/qwen3.5-397b-a17b` / `integrate.api.nvidia.com/v1`
/ apiKey=`${...KEY}`(env 插值,pi-ai 也支持)。OpenAI 兼容,映射 1:1。

**注入机制(真 API,见 `provider-bridge.mjs`)**:
`createAgentSessionServices({ modelRegistry })` → `createAgentSessionFromServices
({ services, model, customTools, noTools:'builtin' })`。schema = `ProviderConfig` +
`ProviderModelConfig`(已读全)。

**到 live turn 的残留(build-out commit,非设计阻塞)**:
1. ModelRegistry 自定义 provider 注入路径二选一:(A) extension `registerProvider` 经
   in-process extension factory 线程进 `services.resourceLoader`;(B) 生成临时 models.json
   →`ModelRegistry.create(authStorage, path)`(registry 无公开 add 方法,custom 走 models.json)。
   B 更确定。需确认 models.json 顶层 schema(`model-registry.parseModels`)。
2. `NVIDIA_API_KEY` env 是否在位(Core onboarding 存的是 env-ref,独立 spike 未必有)。
3. 应在 monorepo worktree 内做:import `@graph/shared` 的 `loadMemexConfig`+`resolveProfile`,
   勿在独立 spike 重写配置解析。pi 需进 workspace(或该 terminal-pi 包单独装)。

## 残留未知（移交 build-out,非 tracer 阻塞）

- 安全抑制:`noTools:'builtin'` 后 `getToolDefinition('bash')` 仍非空(疑 enabled≠registered)。
  build-out 要按**实际 enabled 工具集**核验 pi 裸 bash 真被关,只暴露 Core 容器化 `execute_bash`。
- provider 接线:把 Core onboarded `LLMProvider` 包成 pi-ai `Model`/custom provider
  (`registerProvider`/`streamSimple`),验流式。pi-ai 包布局异常(整仓发布),直接走
  coding-agent 转出的 `ModelRegistry`/`getModel` 路径,勿深挖 pi-ai 内部。
- C3 注入实体:`before_agent_start` handler 内调 Core `assembleContext`+history → 返回
  `{ messages, systemPrompt }`;`agent_end` handler 内 `occWrite` 冲回。
