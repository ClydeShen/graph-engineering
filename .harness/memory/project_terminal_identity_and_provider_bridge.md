---
name: project_terminal_identity_and_provider_bridge
description: "2026-06-15 MemexTerminal 身份层(主题/header/footer) + config-share provider 解析修复 + thinking-model thought_signature 往返(provider-agnostic fetch-shim, 非 fork; Gemini 活体过 27cee228)"
metadata: 
  node_type: memory
  type: project
  originSessionId: 69bb40cc-e7e5-4832-85b8-97874d2f8472
---

延续 [[project_memexterminal_arc_complete]]。2026-06-15 会话(commits 979ea11b..1af378d7)。

**身份层落成(identity layer over pi, ADR-57 DRY, 用户确认方案)**：
- Memex "Observatory" 主题:`packages/terminal-pi/memex-theme.json`(51-token,brass/run-green/rust/indigo/parchment),
  经 `SettingsManager.inMemory({theme:'memex',editorPaddingX:2,quietStartup:true})` + `additionalThemePaths`
  注入(不写用户 ~/.pi)。ui-ux-pro-max 验证方向(Dark OLED + "code dark + run green")。
- 品牌 header(✦ MemexTerminal · model · scope + brass rule) + footer status(setStatus) via `makeChromeFactory`
  (session_start, hasUI 守卫)。quietStartup 关掉 pi 的 [Extensions]/[Themes] 启动噪音。
- **用户截图视觉确认 header/footer/主题生效**。
- 可控:颜色(全 token)/边框/输入框 padding。**不可改(pi 不暴露)**:消息垂直间距(registerMessageRenderer
  仅 custom 类型;不 fork InteractiveMode 守 DRY)、整屏背景(终端 app 自身)。

**config-share provider 解析修复(真 bug)**:`resolveCoreProvider` 原硬编码 `baseUrl ?? nvidia` +
`api='openai-completions'` → 任何非 NVIDIA provider 都被发去 nvidia 端点 → 400。改为镜像 Core 的
`from-config.ts buildOne`(`resolveProfile(entry)` → api/baseUrl/apiKey per profile)。+ Gemini openai-compat
compat shim(`compatFor` 对 generativelanguage baseUrl 注入 supportsStore:false 等;pi-ai detectCompat
不识别 Gemini → 误发 OpenAI 专有 `store` → 400)。**Gemini 纯对话活体通**。

**✅ thinking-model 签名往返已解决(2026-06-15, commit 27cee228, 用户选 fetch-shim 非 fork)**:
Gemini thinking 模型(3.5-flash)工具调用要求回传 `extra_content.google.thought_signature`,pi-ai 只认
OpenRouter `reasoning_details` 不认 Gemini `extra_content` → 修前 agentic 工具 400(`Function call is
missing a thought_signature`)。解法=**provider-agnostic fetch-shim**(`packages/terminal-pi/src/
signature-shim.ts`):pi-ai 不暴露自定义 fetch 且用 `globalThis.fetch`,故在我们代码里装**限定 /chat/
completions 的全局 fetch 包装** —— 从流式响应按 tool_call id 抓 `extra_content`,下一轮原样回声到出站
assistant tool_calls。**零 `if gemini`**(像 hermes chat_completions transport 那样 verbatim 回声任意
vendor extra)→ 用户切任意模型(thinking 或非)自动生效。安装点=`buildCoreModelRegistry()`(幂等,两入口
共用)。只在 `text/event-stream` 响应上 tee,非流式原样放行。10 单测 + **活体过:Gemini 3.5-flash 端到端
跑 execute_bash**(修前会 400)。736 测试零回归。

> hermes 范本:`D:\Repo\specimens\hermes-agent\agent\transports\chat_completions.py`(normalize_response 存
> `extra_content` 到 ToolCall.provider_data)+ `chat_completion_helpers.py`(L990 回放、L1871 流式累积)。
> pi-ai 缺口:`node_modules/.../pi-ai/dist/providers/openai-completions.js`(捕获 L289 / 回放 L716 只走
> reasoning_details)。见 [[project_channel_hermes_deep_dive]]。

**Gemini bare-4xx 误判修复(2026-06-15, commit 96f4f00e)**:用户报 Gemini agentic 工具后报
`400 status code (no body)` + 极小 token(1009)就 compaction + "Context overflow recovery failed"。
根因=**pi-ai `utils/overflow.js` 把 `/^4(00|13)...\(no body\)/` 当 context overflow**(Cerebras 模式);
Gemini 偶发裸 400(瞬时/压缩后消息序列失配)被误判→破坏性 compact+retry→还 400→放弃(compaction 是症状非根因;
已确认 contextWindow=128000 正确读入,1009 token 根本不会阈值压缩)。修法在 signature-shim:裸 4xx **retry 一次**
(请求幂等,OpenAI SDK 不 retry 400)+ 仍裸则塞描述性 body 让 pi 显诚实错误而非幻象 overflow 循环;真 overflow
不受影响(Gemini 带 body "exceeds the maximum")。+ MEMEX_SHIM_DEBUG 诊断。**未能确定复现裸 400 的确定性触发
(5 轮多工具活体复现不出,疑瞬时)→ 修的是失败模式(误判+瞬时 retry)非确定根因**。见 [[project_memexterminal_tui_arc]]。

**⚠ 真正根因(2026-06-15, commit bdc04f53)——shim 在真实 TUI 里根本没运行**:文件日志诊断(~/.memex/shim.log)
发现 `globalThis.fetch===wrapped: true` 但 wrapped **零调用**(真实 `memex chat` 里 pi 的请求全绕过)。根因=
**pi 的 `configureHttpDispatcher()`(interactive-mode 调,`-m` 不调)跑 `undici.install()`(`globalThis.fetch = undici.fetch`)
在我 shim 之后,把 monkeypatch 悄悄覆盖**。所以裸赋值式 monkeypatch 不可靠 —— `-m` 能拦(不走那路径,误导了之前所有
`-m` 活体验证)、InteractiveMode 拦不到。**之前 thought_signature 往返 + bare-4xx 在真实 TUI 里从没生效过**。
修法=**把 globalThis.fetch 装成 getter(永远返回 wrapper)+ setter(捕获后续重新赋值为内层 realFetch)**;
undici.install 用赋值 → 被 setter 拦截,wrapper 永在最外层、内层采用 pi 的 undici(保 dispatcher)。已对 pi 真实
`configureHttpDispatcher()` 验证存活。**活体确认:重开 memex chat 输 hi,CALL/RESP 200 出现、裸 400 消失**(shim 一跑、签名一回传就成功)。
**教训:monkeypatch globalThis.fetch 必须抗重新赋值(getter/setter),否则被 undici.install 覆盖。** 793 测试。诊断日志已移除(0640d0f0)。

**遗留**:NVIDIA qwen 完整 agentic 活体 + 视觉 TUI 全貌确认(本会话用 Gemini 验的,nvidia 状态会变);
send_message(D-6 另一半,channel 依赖);A-plan 最终 rename(terminal-pi→@graph/terminal)。
