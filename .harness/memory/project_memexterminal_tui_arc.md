---
name: project_memexterminal_tui_arc
description: "2026-06-15 MemexTerminal TUI 弧完成(ffcde461): graph-as-working-memory widget + outcome 面板 + /graph /memory 只读 overlay; 建在 pi ctx.ui 不 fork; 46 测试; GH #25"
metadata: 
  node_type: memory
  type: project
  originSessionId: 69bb40cc-e7e5-4832-85b8-97874d2f8472
---

延续 [[reference_gsd2_tui_patterns]](调研)与 [[project_memexterminal_arc_complete]]。**/goal 自主完成**，commit `ffcde461`。
落地了 reference 里那份「可借鉴清单」的全部 4 件，**纯建在 pi 的 `ctx.ui` 扩展层(不 fork InteractiveMode, ADR-57 DRY)**。

**新增**(`packages/terminal-pi/src/`):
- `render-kit.ts` — 宽度/CJK 安全原语(建在新加的直接依赖 `@earendil-works/pi-tui`,因 pi-coding-agent 不 re-export);
  `renderPanel`(copy-clean 无竖边,inline 用)vs `renderFrame`(box,overlay 用)。
- `graph-snapshot.ts` — 廉价防御查询(scope_lineage/execution_event_log/approval_request/procedural_memory);
  **每个查询都 try/catch 兜底**,缺迁移返回默认值绝不崩终端。**活体验证返回真数据非吞错默认值**。
- `graph-widget.ts` — 常驻 aboveEditor「图=工作记忆」面板(scope/turns/trail深度/待审批/最近lesson);
  **full/small/min/off 密度**经 `/density`(持久化 ~/.memex/terminal-agent/widget.json);快照缓存+6s定时器+agent_end刷新,render 内不 await。
- `outcome.ts` — 状态着色面板(complete/blocked/denied/failed),接审批被拒(deny 时 set,下个 agent_start clear)。
- `graph-overlay.ts` — `/graph`(scope trail)+ `/memory`(lessons)只读可滚动 overlay(esc/jk/g/G),
  照搬 gsd `GSDNotificationOverlay` 契约(render/handleInput/invalidate/dispose)。

**决策(≥mid, 标本+research)**:密度走 `/density` slash 命令非键盘快捷键(避免按键冲突,比 registerShortcut 稳);
工具运行记为 `memory_updated` 事件(图原生,classifyEvent 归 memory,符合数据模型,活体确认);pi-tui 加为直接依赖不自己重写宽度计算。

**UI/UX(ui-ux-pro-max 执行)**:color-not-only(glyph+词+色三重)、语义 Observatory token、渐进披露(密度)、
留白分组、空状态带引导、单一 glyph 家族无 emoji、左对齐、copy-clean。

**去重+清爽重设计(d0f92159, 用户反馈"重复+啰嗦")**:原来 brand/model/scope 在三处重复(我的 header banner + widget + pi footer)。
修:**删 makeChromeFactory**(顶部 banner + footer status)→ widget 成唯一 memex chrome,model/cwd/tokens 归 pi footer;
widget 瘦身(去 model、删"no lessons yet"空状态噪音、去尾 rule,full 3-4 行 / small·min 各 1 行);
**新 bash-output.ts `formatBashOutput`**:execute_bash 返真 stdout(真换行)+ 紧凑 stderr/exit,不再吐 `{"stdout":"...\n..."}` 转义 JSON。
每个数据只出现一次。另修 Gemini 裸-4xx 误判(见 [[project_terminal_identity_and_provider_bridge]] 96f4f00e)。

**验证**:46→新增至 **793 串行全绿**(format-bash 6 等);tsc 0;活体 `memex chat -m` 工具输出清爽 + widget 稠密无重复。
**关键:改动走源码(tsx 直跑),用户需重开 `memex chat` 才见新 UI + 400 修复**。
**遗留**:① 交互 TTY 像素级渲染本机非 TTY 无法驱动(纯渲染已 46 测试覆盖+集成模拟 hasUI 跑通 setWidget/render/dispose/density);
② **预存 flake(非本次)**:并行 `npm test` 间歇在 nesting/idempotency 死锁(迁移 DDL 并发竞态,我没碰那代码)——`vitest run --no-file-parallelism` 782/782 绿。
