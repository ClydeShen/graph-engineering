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

## 残留未知

- `[ASSUMPTION]` `before_agent_start` 粒度（= kill-criterion,步骤 4 验）。
- `[ASSUMPTION]` `streamSimple` 签名能否干净包住 Core 的 `LLMProvider.chat/chatTurn`
  接口（步骤 2 stub→real 验）。
- coding-agent 自带 bash/edit/write 工具与 Core `execute_bash`（CommandGate+容器化）
  的关系：是禁用自带 bash 只用 Core 的,还是让 Core 接管 backend?（量产期决策,非 tracer）。
