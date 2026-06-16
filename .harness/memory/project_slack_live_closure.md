---
name: project_slack_live_closure
description: "Slack connector wired into gateway-bot + ack-before-dispatch live-verified; \"connector implemented but unwired\" recurring pattern"
metadata: 
  node_type: memory
  type: project
  originSessionId: ce065d28-6967-4ae2-8256-90e924fe9b18
---

2026-06-13 (/goal fuller): Slack 活体闭环完成(commit 05639bdf)。

**可复用洞察 —— 「连接器写好但没接进入口」反复出现:** `SlackConnector`(Phase 12 写好+单测过)
**从未被 `GatewayBot.start()`（packages/gateway-bot/src/index.ts）实例化** —— 入口只手接了
Telegram/Discord/Email。`WebhookConnector` **仍未接**。`ConnectorRegistry` 只被 DeliveryRouter(出站)用,
入站根本没走它。**教训:加新 channel 必须接进 index.ts;查未接线先看那里。** 同 execute_bash docker 一样属
「logic-done+单测绿 ≠ 接线」(Proxy Signal 家族),见 [[feedback_live_verification_policy]]。

**Slack 活体证据(真实 SlackConnector.start() 路径,本机直连 slack.com):**
auth.test→bot @memex(U0BA827GTSR)/team Memex(T0BAETHG9K6);apps.connections.open→WSS(Socket Mode 开);
首帧 hello。**ack-before-dispatch 决定性验证**(可注入 wsFactory 包真 socket + 故意 sleep 4s):
IN envelope→OUT ack(同 id 同毫秒)→dispatch(后 1ms)→4s 窗口零重投→chat.postMessage 回复用户目视确认。
单测测不到的那条协议现已活体证明。默认无 SLACK_* env 行为不变;gateway-bot 62 测试绿。

**残留:** ① ~~SlackConnector 裸 fetch 不走代理~~ **已收口(commit ee1b1765)**:fetch + WSS 两条腿都改走
channelDispatcher('SLACK_PROXY',...)(undici WebSocket 接受 WebSocketInit{dispatcher}),活体验过直连不受影响。② 无白名单门禁(任何能私信者都得回复)—— 生产缺口,归信任隔离待办。
③ WebhookConnector 未接线。相关:[[project_phase12_complete]]、[[project_channel_connectivity_fix]]、[[project_channel_hermes_deep_dive]]。
