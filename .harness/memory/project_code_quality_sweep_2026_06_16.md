---
name: project_code_quality_sweep_2026_06_16
description: "roam-driven code-quality/architecture sweep — MCP tool registry deepened, dead code swept, terminal de-dup decisions"
metadata: 
  node_type: memory
  type: project
  originSessionId: c0e4ac7d-ea75-4c78-aa54-0fc38b464167
---

2026-06-16，roam 驱动的代码质量/架构 sweep（`/improve-codebase-architecture` + `/goal`）。4 commits 已推 master（…c21c7ae9）。基线/收尾：tsc 0 · 串行 793 测试绿（零回归）· 活体 E2E journey 11/11 绿（新启 gateway 跑当前源码）· ADR-49 回归门零指标漂移。

**已落地：**
- **#1 MCP 工具注册表深化（52cfd2ee）** — `buildMcpServer` 从 161 复杂度（全库最高，13 工具内联）拆成 `packages/gateway/src/mcp/tools/`：每工具=顶层命名 handler + factory(pool)。`buildMcpServer` 现为薄注册循环(cx~3)。**这是 ADR-57 后果#3 点名的 seam**：in-process Pi 现可复用同一份工具定义，消除 execute_bash/schedule_task 两套实现漂移。模式经 **hermes 标本**(tools/ registry 解耦 dispatch)背书。行为逐字保持、顺序保持、env-gated 工具(execute_bash/browser)禁用时 factory 返回 null。
- **#3 死代码清理（3e3767a5）** — 删孤儿 tracer `run-exec-bash.mts` + 未用 `renderBar`。保守：**roam 的 80 死导出列表多为误报**——`graphSignature` 实际被 canvases 用（roam 漏看 .tsx 导入）、test-only seam、latent 未接线特性(`DiscordConnector`/`recordConfigChange` 删了会丢能力)。**纪律=删前必证**。

**决策（防未来架构审查重提）：**
- **#2 终端不 rename** — `@graph/terminal`(瘦 readline)仍是 `npm run dev` 前台 + 非 agentic 对话核心探针，有真实调用方(scripts/dev.mjs)。`terminal-pi → @graph/terminal` rename 是**有意识的独立动作，前置=REPL/-m 对等**(见 [[project_terminal_naming_and_byo_decisions]])，不在自主目标里强推。只清了真摩擦：USER_MANUAL §9 过期入口 + `--agent` 死消息(都改指 `memex chat`)。
- **#4 test-only exports 延后** — ~32 个 export 只作测试 seam(实现泄漏过接口)。最低置信、需逐例判断；零回归约束下批量改 32 seam 是 KISS/YAGNI 反对的 churn。**日后触碰各模块时顺手处理，不做 sweep**。

**续：dispatcher 深化贯穿全弧（同日，再 2 轮，已推 …ba5d1a1f）。** 同款「god dispatcher → 每动作命名 handler + 薄 switch」模式扩展到全部 CLI/WS 入口：`runMcpCommand`(76)+`runCapabilityCommand`(47) → 每子命令 handler（bdec96a7）；`handleWsMessage`(63,16返回) → handleSubscribe/UserMessage/AgentEvent，按 WsClientMessage 判别联合成员收窄（b8e5ac99，ws.test 12 守）。全部离 critical 榜。ARCHITECTURE.md §7 修正（8→13 工具，补 ADR-53 autonomy 族，fead4250）。

**第 3 轮诚实结论（重要决策）：无安全码改赢点了**——剩余复杂度热点全是 ① React page 组件（WorkspacePage/Sessions/Universe/Forest，视觉回归风险+测试薄+视觉验证部分受阻）或 ② 敏感运行时无编排测试（`GatewayBot.start` 有「写好没接线」静默 bug 史且 start() 无测试；`runOnboard` 交互式；`runConversationTurn` ADR-54 TRIPWIRE）。**自主目标下零回归约束 → 强行重构这些是风险>回报，有据延后**（要做需带针对性验证、非自主 sweep）。

**两条纪律（沉淀）：** ① roam 死导出列表对本库**误报主导**（Next 路由/JSX/barrel 都被读成 no-consumers，如 Input 被 80 处用却标 dead）→ 勿用于删除。② 旧记忆**不激进删**——早期 BLOCKED 等状态被后续条目在上下文中取代、且反映写入时为真，整批重写是高判断低价值 churn，呈报代替销毁。

关联 [[project_memexterminal_pi_embed_adr57]]（ADR-57 = 工具复用 seam 的动机）、[[feedback_sync_before_writing_code]]。
