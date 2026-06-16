---
name: memex-terminal-design
description: "MemexTerminal 补强弧的协议+多模态设计五梁（fuller 收口 2026-06-14）。角色/应答者/协议信封/前向兼容/artifact 模型全锁。两支未钻（X 工具执行+审批 / Y TUI 驾驶舱面）。设计阶段、未起工。"
metadata:
  node_type: memory
  type: project
  originSessionId: 151d19e7-1ea8-47b6-a8d3-a25a82a9b53c
---

设计讨论收口（2026-06-14，fuller）。MemexTerminal 现状 = 只对话的 readline REPL（`packages/terminal`，纯 gateway WS 客户端）；用户判定「功能非常不完整」，要基于愿景讨论补强。**设计阶段、未起工**。

**🎫 权威 = GH issue [#25](https://github.com/ClydeShen/graph-engineering/issues/25)**(epic, status:on-hold) + **ROADMAP §23-memex-terminal**。本记忆是辅助,真源是 issue+ROADMAP。snapshot 见 `.harness/PROJECT-SNAPSHOT.md`。

## 现状基线
- `packages/terminal/src/index.ts` = readline REPL：建临时 scope→连 WS→发消息→流式 `text_delta`→把非 memory_updated 的 trail 当暗行回显。`-m` 单轮脚本模式。`/quit` 外无命令。对图（trail/lesson/emergence/scope）几乎全瞎。
- 人类交互面三分：**CLI**(ops+`log`原始)/**Terminal**(只聊天)/**Console**(Web 富观测,要浏览器)。结构缺口 = 无浏览器时没有图原生交互窗口。

## 五梁（全锁）
1. **角色**：Pi-SDK 改造、成型为 **类 Claude Code TUI 应用**。**≠ `memex connect pi`**（那是 Pi 作外部 agent 经 MCP 接入；这里 Pi SDK 是构建 Memex 自身终端的地基）。与命名锁记忆一致 [[project_memex_terminal_naming]]。**⚠️ Y 修订（2026-06-14）**：TUI **表面不是图驾驶舱**——是**瘦聊天端**（聊天 + task 状态）；图观测**交给浏览器 Console**；scope 在 terminal 里是噪音。「图原生核心」重定位为**后端**（图=SSOT、gateway=脑），非 TUI 表面。详见末尾 Y 段。
2. **应答者位置 = (iii)**：Pi SDK 做**皮 + 循环外壳**，真正的 LLM turn/工具编排**委托给 gateway 对话核心**（ADR-54 `0063-adr54-conversation-core.md`）。保住 ADR-54 三条承重不变量：**服务端单应答者 / 本地免 key（跨机裸连）/ 全渠道一致**。否决 (ii) 本地 agent loop（要本地 key、terminal 与其它渠道分叉、易滑回 `Context=State`）。ADR-54 D-3 亲口把「完整 agentic 循环」推迟给「MemexShell 正篇」——本设计 = 续写那个正篇。
3. **协议成长 = C**：一次定**统一类型化信封**（≈ Anthropic Messages 形状）——入 = content blocks（`text/image/tool_use/tool_result`）；出 = 类型化事件流（`text_delta/tool_call/tool_result/approval_request/thinking/done`）。所有高级功能变加法。**实现顺序：先 agentic 文本流（工具+审批，纯文本、不需 blob 层），多模态第二批。** 当前协议（ADR-54 D-3）只有 `user_message{text}`→`text_delta`，纯文本单工具。
4. **前向兼容多模态 = A**：版本化判别联合信封。turn-based 现在覆盖 text/image/video/**按键说话式语音**；**实时全双工语音留 v2 门**（靠 `protocol_version` + 联合可加 `realtime_session` 成员，不破 v1；纪律=别把 turn-based 焊进类型）。否决现在焊 `session_mode`/双传输（YAGNI）。能力门在**既有 seam**：`ProviderProfile`(`provider-profiles.ts`,已有 `supportsEmbedding`/`supportsToolTurns`)顺势扩 `supportsImage/AudioIn/AudioOut/Video`。承重律：**图+信封最大 permissive（任何模态永久存、模态盲）；所有能力判断隔离在 provider seam**→上新模态 = 一个 flag+adapter，零图/信封迁移。
5. **artifact 模型 = A（统一 reference-by-path、无 CAS）**：账本只记 `{path-or-URL, media_type, origin}`，**永不存字节**；粘贴/录制**落成用户可见文件**再走同一引用模型；base64 仅调用时临时 wire 编码。**研究背书**：Hermes(`agent/image_routing.py`)正是 path/URL 引用 + base64 仅 wire + `native`vs`text` 按 `supports_vision` 门控 + sanitization 剥历史图，**无任何 managed store**。重想掉了上一轮的「软 CAS」（Hermes 无先例,置信<0.5,用户令重想→丢弃）。blob = knowledge 层 artifact（knowledge/tools/worker 三层）；账本是 worker 执行记录,**指向**而非**拥有** knowledge。

## 三线合一的关键洞见
**悬空 artifact 引用 = #24 缺失的 `failure_count` 路径 = 涌现软化机制**。用户删文件→引用悬空→不报错→依赖它的 workflow 失败/不强化→置信衰减→Ebbinghaus 取代→软化退化,或涌现别的 workflow。把 [[project_emergence_loop_validation]]（#24）、[[project_skill_hardening_vision]]、本设计收到同一机制上。同源于 **ADR-43 erase**（hash 作「曾存在」承诺、内容可消失、验证容忍）与 append-only 柔术。

## Y 收口（2026-06-14）—— TUI 表面 = 瘦聊天端，非图驾驶舱
用户切法：terminal 里只关注**对话 + task 是否完成**；图观测交浏览器；**scope=噪音**。这推翻了原梁①的「图原生驾驶舱」定位（已改梁①）。

- **决定 = Q（先落第一砖）+ P 留 seam**：
  - **Q（现在落）**：聊天为中心(满屏) + **一行状态行**(`idle/thinking/running<tool>/⏳等审批/N异步任务`,A2) + **审批等离散异步事件内联插播**(A3,审批必须打断否则 5min 超时用户不知)。任何图/scope 视图 → **一键开 Console**。
  - **P（留 seam 不阻断，成型态）**：lazygit 式**渐进披露**——默认藏、一键揭可折叠面板(状态/活动 command-log/当前 scope trail/lessons)、一键收起;力导向「Now 宇宙」终端画不了的归 Console。纪律=别把「单视图」焊进布局(同实时语音留 v2 门)。
- **lazygit research 背书**(ctx7 `/jesseduffield/lazygit`)：① 屏幕模式`+`/`_`溶掉「精简 vs 面板」伪二选一→默认藏+一键瞥;② command-log=A3 已被验证且可折叠;③「在浏览器打开」验证 terminal→Console 交接 seam;④ **决定性**:lazygit 面板**可操作**(stage/rebase),Memex scope/trail **只可观察**→被动展示易成噪音,**面板只有可操作才挣得位置**→背书用户砍图。置信 **high**(四维齐,research 补齐)。

## 一支未钻（恢复入口）
- **X — agentic 文本流层（实现第一砖）**：工具在哪执行 / 审批怎么走。接现有 `execute_bash` 容器化（docker backend 已接线,[[project_execute_bash_containment_unwired]]）+ ADR-47 审批状态机（`0056-adr47-trust-isolation.md` D-2 跨渠道审批/D-4 执行后端）。**钻前需先读 execute_bash + ask-user 现有实现。** 注：X 的审批 UI 端就是 Y 的 A3 审批插播——两支在「审批」处交汇。

关联:[[project_memex_terminal_naming]] [[project_emergence_loop_validation]] [[project_skill_hardening_vision]] [[project_console_redesign_now_universe]] [[feedback_confidence_four_dimensions]] [[project_execute_bash_containment_unwired]]
