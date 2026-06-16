---
name: project_telegram_hardening_allowlist
description: "Telegram inbound allowlist edge-gate + webhook secret (channel-allowlist.ts, reusable); hermes posture; live-closed"
metadata: 
  node_type: memory
  type: project
  originSessionId: ce065d28-6967-4ae2-8256-90e924fe9b18
---

2026-06-13 (/goal 硬化telegram, commit 2e077792)。Telegram 原为 open-by-default:`TELEGRAM_BOT_TOKEN`
一设,任何找到 @memememex_bot 的人直达 `dispatchMessage` → 会话核心 →(execute_bash)。这是本会话
[[project_slack_live_closure]] 标记的 Slack 残留②(无白名单)的同病、且更危险。

**收口 = 港 hermes 姿态(不重复造轮子):** roam_retrieve hermes → 中央门 `GatewayRunner._is_user_authorized`
(gateway/run.py)+ `TestAllowlistStartupCheck`。只港核心姿态,**不**全量搬 900-token 多平台巨函数(YAGNI):
allowlist 设了→只放行列内、其余**丢弃 fail-closed at the edge**;空→放行但 start() 打一次性安全告警;`*`→显式 allow-all。

**新 seam(可复用):`packages/gateway-bot/src/channel-allowlist.ts`** —— channel-agnostic
(`parseAllowlist`/`isChatAuthorized`→{allowed,reason}/`allowlistStartupWarning`),Slack/Discord 后可上同一个门
(hermes 也是单一授权路径)。Telegram 已接(`startLongPoll`+`startWebhook` dispatch 前门控,`index.ts` 读
`TELEGRAM_ALLOWED_CHATS`)。webhook 另加 `TELEGRAM_WEBHOOK_SECRET`(secret_token + header 校验拒伪造 POST);
setWebhook 顺带裸 fetch→telegramFetch。

**活体闭环(出货代码 + 真实 DM):** 一次性 harness,真实 DM chat=513580037 跑出货 `isChatAuthorized`:
vs `['999999']`→denied(丢弃)、vs `['513580037']`→listed(放行),回复目视确认。root tsc clean;gateway-bot
73 测试(原 62)。遵 [[feedback_live_verification_policy]]。

**残留:** ① webhook secret 校验 unverified-live(本机无公网 URL),落地=有公网入口时带/不带 secret 各 POST 一次。
② 群组按 from.id 细分留 YAGNI。③ Slack/Discord 未上门(seam 已备)。相关 [[project_channel_hermes_deep_dive]]。
