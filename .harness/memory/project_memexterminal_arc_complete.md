---
name: project_memexterminal_arc_complete
description: "MemexTerminal (Pi-embed, ADR-57) 弧完成 2026-06-15；memex chat 启动 agentic 终端；726 测试零回归"
metadata: 
  node_type: memory
  type: project
  originSessionId: 69bb40cc-e7e5-4832-85b8-97874d2f8472
---

MemexTerminal (Pi-embed) 弧自主完成（2026-06-15，commits e5ba6385..44475114）。`memex chat`
现启动 Pi 内嵌 agentic 终端（取代瘦客户端 dispatch）。延续 [[project_memexterminal_pi_embed_adr57]]。

**已实现并活体（ADR-57）**：
- D-1 R-A 库内嵌 + D-2 config-share 借 Core 脑 + D-3 C3 图为工作记忆 + D-4 审批双写 + D-5 execute_bash。
- 组装真终端 `packages/terminal-pi/src/terminal.ts`（createMemexTerminalRuntime：脑+C3+工具+审批+隔离）
  + `index.ts`（-m 可脚本 / 默认 pi `InteractiveMode` TUI，DRY 不自研 loop/审批/TUI）。
- embed 隔离修复：`EMBED_RESOURCE_ISOLATION`(noExtensions 等)，不吸收外部 ~/.pi（修 spawn_task/complete_task 泄漏）。
- D-6 schedule_task（图原生 upsertCronJob，gateway-bot tick fire，审批门控）。
- execute_bash 抽 `runExecuteBash`（gateway/mcp/execute-bash.ts，MCP+Pi 共用消除漂移）；cron 抽 upsertCronJob。
- memex chat → `@graph/terminal-pi`；瘦客户端「--agent retired」注释改写（per-surface 律不冲突）。

**收口验证**：typecheck 全工作区 0 错误；**726 测试零回归**（107 files）；完整 agentic journey
活体（真 NVIDIA qwen3.5：写文件→cat 读回→报告，落盘+落 trail）；C3 跨进程 teal；schedule_task。

**关键修的 bug**：C3 agent_end 用 user 轮 hash 作 OCC predecessor → execute_bash 在轮内 append 移动了
tip → 过期 hash 致冲突、助手轮静默不落库（空回复）。改用当前 tip。

**剩余（非阻塞）**：
1. interactive `InteractiveMode` TUI 需真 TTY 活体（runtime 已由 -m 全验）。
2. **send_message 延后**=outbound-parity；正确实现需 ConnectorRegistry（活连接器在 gateway-bot 进程，
   terminal 自建会重复起 bot 消费者），且需配置 channel 才能活体验证 → 专门切片。
3. A-plan 最终 rename：terminal-pi → `@graph/terminal`（需先到 REPL/-m 功能对等）；见 [[project_terminal_naming_and_byo_decisions]]。
4. dev-mode：tsx 从仓库外目录启动 memex chat 因 workspace 路径别名失败（生产编译无此问题）。

权威细节见 `.harness/implementation-notes.md`（build-out #4~#9）+ ADR-57（docs/adr/0066）。
