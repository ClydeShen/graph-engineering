---
name: project_terminal_naming_and_byo_decisions
description: "2026-06-15 拍板：terminal-pi→@graph/terminal(A方案,最终接线刀做)；pi-extension=BYO,核心+shell稳后再处理"
metadata: 
  node_type: memory
  type: project
  originSessionId: 69bb40cc-e7e5-4832-85b8-97874d2f8472
---

2026-06-15 build-out 绑 execute_bash 期间的命名/范围决定。

**Terminal 命名 (A 方案,只动 terminal)**:
- `@graph/terminal-pi`(Pi 内嵌)= 真 MemexTerminal,终态升为 `@graph/terminal` 规范短名;现 `@graph/terminal` 瘦客户端(ADR-54 一应答者)的 REPL/`-m` 表面折叠进来或降为 `@graph/terminal-client`。**真包名 rename 放到最终接线刀**(Pi-embed 需先到功能对等)。
- **范围限定**:只动 terminal,**不做**全局 `@graph/*`→`@memex/*` branding 对齐(产品名 MemexOS/Core/Shell/Terminal 仍与包名 @graph/* 脱节,暂接受)。
- 过渡期:prose/注释一律叫 "MemexTerminal (Pi-embed)",不再用 "terminal-pi" 当品牌(它把 Pi SDK 实现细节暴露成像外部系统,让用户困惑)。

**pi-extension = BYO,不动**:
- `@graph/pi-extension` = 外部 Pi 连接器(`memex connect pi`,拷进 ~/.pi,MCP-over-HTTP,Pi 自己的脑)。含独有的 fork+shadow 排练模式(阅后即焚)+ 排练守卫,terminal-pi 未覆盖。
- 它是 ADR-57 per-surface 反转所取代的「外部 Pi agent」旧模型遗留,但有独立 BYO 价值。
- **决定:不动。BYO 范畴,等核心(MemexCore)+shell(MemexShell)稳定后统一处理。** 名字无歧义,保留。

**关联**:更新 [[project_memex_terminal_naming]](旧锁定:MemexTerminal=内置TUI/外部Pi=Pi Terminal,仍成立);[[project_memexterminal_pi_embed_adr57]](ADR-57 per-surface 反转);[[project_now_realtime_and_hermes_gap]](X 梁=到 Hermes 缺口)。
