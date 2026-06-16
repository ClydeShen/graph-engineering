---
name: reference_gsd2_tui_patterns
description: "gsd-2 标本 TUI UI/UX 可借鉴清单(同 pi 地基,纯 ctx.ui.* 不 fork) + 我们 pi 0.79.3 已具备 setWidget/custom/setFooter API; 挂 GH #25 MemexTerminal epic / lazygit 概念"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 69bb40cc-e7e5-4832-85b8-97874d2f8472
---

学习自 [[reference_specimens_directory]] 的 **gsd-2**(`D:\Repo\specimens\gsd-2`,roam 已索引)。
挂 **GH #25 MemexTerminal epic** + [[project_memex_terminal_design]](X 梁/lazygit 概念)。2026-06-15 调研,**纯学习未落码**。

**关键发现:gsd-2 的终端不 fork pi 的 `InteractiveMode`,纯靠 pi 的 `ctx.ui.*` 扩展钩子定制 TUI** ——
与 MemexTerminal 同地基(ADR-57 DRY)。**gsd 在 TUI 上做的每件事我们都能合法照搬**。
已确认我们的 `@earendil-works/pi-coding-agent@0.79.3` 暴露全部 API:
- `setHeader`/`setStatus`(我们已用)、**`setWidget(key, factory, opts)` 编辑器上/下持久面板(我们没用=最大空白)**、
  `setFooter`、**`custom(factory,{overlay})` 带键盘焦点浮层(lazygit 式可交互面板真入口)**、`setWorkingIndicator`、`setTitle`。
- setWidget 签名:`(tui, theme) => Component & {render(width):string[]; invalidate(); dispose?()}`;footer factory 收 `ReadonlyFooterDataProvider`(git branch + `getExtensionStatuses()`)。

**可借鉴的 UI/UX 模式(源文件)**:
- **Widget 层**(`auto-dashboard.ts updateProgressWidget` → `setWidget("gsd-progress")`):常驻面板「一眼看全局」
  =你之前 /fuller 的 **lazygit 概念**落地形态,无需 fork。
- **自适应密度** full→small→min→off 快捷键循环 + 持久化 preferences(`WidgetMode`)。
- **render-kit**(`src/resources/extensions/gsd/tui/render-kit.ts`):`renderPanel`(**故意不画 │ 竖边→终端选区复制是干净文本**,
  copy-clean 洞见)、`renderProgressBar`、`rightAlign`、`padRightVisible`、`wrapVisibleText`、`statusGlyph`、两栏合成;
  建在 `@earendil-works/pi-tui` 的 `truncateToWidth`/`visibleWidth`(我们也有此包)。
- **语义主题 token**:`accent/text/dim/muted/success/warning/error/borderAccent` = 我们 Observatory `memex-theme.json` 同套词汇,零适配。
- **渲染性能纪律**:按 width 缓存帧;spinner 200ms 定时器/贵数据(DB·git)15s 定时器;`tui.requestRender()`;定时器 `unref()`;
  **render 里绝不 async/阻塞**;session 切换中返回上一帧防冻屏;git last-commit 缓存 15s。
- **Outcome 浮层**(`setAutoOutcomeWidget`):状态着色 panel(图标+Reason+Last+Next+命令)→适配审批被拒/blocker/完成态。

**落到 MemexTerminal 的清单(性价比序,均为建议未验证)**:
1. `packages/terminal-pi/src/render-kit.ts` 照搬(panel/progressbar/两栏/copy-clean) —— 一次性投资。
2. **Memex 图 widget** `setWidget("memex-graph", …)`:可视化「图=工作记忆」(当前 scope/turn 数/最近 lesson·crystallization/
   待审批数/trail 深度)+ full/min/off 密度 —— lazygit 概念最小落地。
3. Outcome 面板复用到审批被拒/blocker/完成态。
4. `custom()` 浮层做 `/graph`、`/memory` 只读浏览器(#25 下一步,呼应「可观察≠可操作→先只读」Y 收口)。

**边界(不照搬)**:gsd-2 是工作流自动化产品,widget 内容是 GSD 领域(milestone/slice/task/auto-mode 阶段机)。
**借机制+UX 模式,不借内容** —— 我们的内容是图(scope/trail/lesson/approval)。

置信度中-高(参考代码✅已确认 pi API + research✅读源码 + 用户判断✅;落地方案本身待构建验证)。
