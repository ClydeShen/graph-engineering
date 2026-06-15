# ADR 57｜MemexTerminal = Pi SDK 库内嵌（R-A）+ 图为工作记忆（C3）

status: accepted（2026-06-15；fuller 会话拍板，docs 已结算 Pi 能力，tracer bullet 待验集成）
日期: 2026-06-15

---

## 上下文

到 Hermes-like / Pi-like 体感的唯一阻塞是「人面 agentic 表面」：agentic 机器已全部
存在并 journey 验过（`execute_bash` 容器化、`ApprovalService`、`AskUserService`、
13 个 MCP 工具、channels、cron），缺的是一个**用起来像真 agent 的 TUI**。

ADR-54 已立对话核心（`runConversationTurn`）：gateway 侧无状态应答循环，**故意非
agentic**——只 `memex_retrieve` 一个工具，散文优先提示，TRIPWIRE 测试断言「无外部
工具」。这是给 channel（Telegram/Slack）画的信任边界,terminal 与各渠道共享同一核心。

shipped 的 `terminal/index.ts` 把 `--agent`（Pi session）**retired** 了，理由是
ADR-54「对话只有一个应答者」，Pi 被推到外部当异步 worker（`memex connect pi`，
claim 任务）。本 ADR **有意识地反转**这一点：让 Pi 回到 terminal 内部当主应答者——
但只在 **terminal 这个表面**,channel 表面仍走 ADR-54 对话核心,信任边界不动。

目标（用户原话）：MemexTerminal 体感像 hermes/pi agent，是真 agent TUI；用 Pi SDK
是为 **DRY**——不自研 loop/审批/TUI,启动即自带;只是有强大的核心账本做背书。

### Pi 能力已由 ctx7 文档结算（`/earendil-works/pi`）

| 需求 | Pi 原语 | 结论 |
|---|---|---|
| 借 Core 的脑（免 key） | `registerProvider({ streamSimple })` 或 `{baseUrl, api:"openai-completions"}` | ✅ 一等公民 |
| 绑 in-process Core 工具 | `registerTool({ async execute(...) })` | ✅ |
| 每轮注入图投影 | `on("before_agent_start")` → 返回 `{ messages, systemPrompt }` | ✅ |
| 整轮冲回账本 | `on("turn_end")` → `event.message, event.toolResults` | ✅ |
| 审批插播 | `on("tool_call")` + `ctx.ui.confirm()/select()/input()` | ✅ |

## 决策

### D-1：R-A 库内嵌——一个进程,直接 import MemexCore 函数

MemexTerminal 改造为一个**基于 Pi SDK 的进程**,in-process `import` MemexCore 包
（工具 handlers、`processAgentTurn`/`assembleContext`、`ApprovalService`）,注册成
Pi 的工具与记忆。**不走 MCP**（否决 R-B「原生协议远程」：那等于重新发明一个不叫
MCP 的 MCP,吃掉 DRY 收益）。「直接搭在 Core 上」= 字面的同进程函数绑定。

### D-2：脑 = Core 已 onboard 的 provider,经 `streamSimple` 同进程委托

`pi.registerProvider("memex", { streamSimple → 委托 Core 的 LLMProvider })`。R-A 是
同进程,Pi 的脑直接调 Core 的 `LLMProvider` 接口,**连 HTTP 都不用**。onboarded
provider 原样复用 → 保住 ADR-54 的「免 key / 渠道一致」：terminal 的脑 = channel/
console 的脑,同一个。

### D-3：C3——图是 agent 的工作记忆,每 turn 投影注入（不是审计后盾）

「核心账本做背书」= 账本是 agent **推理所依的记忆**,不是事后日志（否决 C1：C1 让
Pi 自持上下文、账本沦为 append-only log,会把 20+ Phase 建的 assembleContext /
reflection 注入 / CCR / 晶化反哺 / capability endorsement 对 terminal 整体旁路）。

- **跨 turn 上下文**由 Core 每轮从图投影,经 `before_agent_start` 注入 Pi 的起始
  `messages` + `systemPrompt`（= 现 `runConversationTurn` 的 `loadConversationHistory`
  + reflection/CCR,只是回路主人换成 Pi）。
- **turn 内** loop 状态（工具迭代、审批暂停）由 Pi 临时持有——本就是临时,无妨。
- **整轮**经 `turn_end` 经 `occWrite` 写回账本。Pi「持有」的 message list 每轮被图
  重新播种、再冲回图,**从不是权威状态**——是恰好活在 Pi 进程里的一份每轮投影。

这保住了 Memex 根本大法「Graph → Context, never Context = State」**在 terminal 也成立**。

### D-4：审批 = `tool_call` hook → `ctx.ui.confirm` 双写 `ApprovalService`

gated 工具（CommandGate dangerous / capability_install / browser / send_message /
schedule_task）在 `tool_call` hook 拦截:本地 `ctx.ui.confirm()` 插进聊天流给即时
体感,**同时**写 `ApprovalService`（落 `approval_request` 行 + `memex::security::
approval_*` 审计事件 + 可经 DeliveryRouter 跨渠道回声）。本地 confirm 是 UX 快路径,
`ApprovalService` 是审计权威——两者不互斥,审计行是 SSOT。

### D-5：分两段交付——骨架(tracer) 先,量产(tool-binding) 后

- **tracer bullet（本弧）**:Pi 嵌入 + D-2 `streamSimple` 跑通一轮 + 绑 **1 个**最简
  Core 工具 + 1 次 `ctx.ui.confirm` + `before_agent_start` 注入投影 + `turn_end`
  冲回。证明 5 根线端到端通。**kill-criterion = 钉死 `before_agent_start` 触发粒度
  为 per-user-prompt（用户发新消息才重投影,内部工具循环 turn 不重投影）。**
- **量产（后续切片,机械重复,低风险）**:绑 `execute_bash`（→ 直接产代码 + 用系统
  工具）、scope create/resume/switch（→ 管理 session）、`send_message`/`schedule_task`
  两个新工具、artifact 路径。**到这里 MemexTerminal 才是完整 agent TUI。**

### D-6：补两个 Hermes-parity 工具,仅 terminal agentic 表面,永不进 channel

确认现 13 工具**不含**:`send_message(channel, text)`（主动出站,复用 DeliveryRouter,
默认 approval/allowlist-gated——跨信任边界）、`schedule_task(when, intent)`（复用
gateway-bot cron 机制,默认 approval-gated——自治升级）。两者只注册进 terminal 的
agentic profile,**channel 对话核心永不获得**（ADR-54 信任边界 + Phase 14 红线）。

## 后果

- ADR-54「一个应答者」从全局律降为**per-surface 律**:channel = 对话核心（无工具）,
  terminal = Pi agentic（全工具）。TRIPWIRE 仍真——它断言的是 channel 表面。
- `terminal/index.ts` 现「`--agent` retired」注释作废,需改写;`MemexTerminalClient`
  瘦协议客户端在 agentic 模式下被 Pi 进程取代(R-A 同进程,不再走 WS 远程)。
- 13 个 MCP tool handler 需从 `buildMcpServer` 抽成独立函数,让 MCP-over-HTTP 与
  in-process Pi 两路调同一份,消除「两套工具实现」漂移。
- artifact:沿用 ADR-52 / 后续 per-project 路径约定,Pi 的 `onUpdate` 流式产物落文件。

## 关联

- ADR-54（对话核心,0063）— 本 ADR 的 channel 侧孪生;C3 复用其投影机制
- ADR-53（autonomous-assistant,0062）— ApprovalService/AskUserService/capability 工具
- ADR-47（trust-isolation）— 审批状态机 + 信任边界红线
- GH #25（MemexTerminal epic）/ ROADMAP §23 — 本 ADR 是其架构基石
- Pi: `/earendil-works/pi` — extension/hook 系统(registerTool/registerProvider/on)
