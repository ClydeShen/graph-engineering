---
name: project_channel_connectivity_fix
description: "external channel connectivity (Telegram/Discord) reuses hermes-agent's proxy+IP-fallback approach via shared channel-http.ts"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7c30552c-d95b-427b-9507-d8611736e880
---

External channel connectivity was fixed 2026-06-13 (commits fadcdf16, 9a2d0ed1)
by porting hermes-agent's proven approach DRY, not reinventing.

**Three root causes** behind "telegram pairing failed" + "dashboard won't open",
all surfaced via `memex log` + live probes:
1. dev.mjs Windows PATH duplicate-key — the env key is `Path`, code read/wrote
   `PATH`, creating a 2nd key; children got a bun-only PATH clobbering the real
   one, so `npm` was "not recognized" → console never started → port 3000 dead.
2. undici Happy-Eyeballs 250ms per-family cap abandoned Telegram's working IPv4
   (IPv6 unroutable, IPv4 handshake ~283ms). The .env token was valid all along
   (getMe → ok:true). curl worked because it has no such cap.
3. No proxy / IP-fallback resilience for restricted networks.

**Fix**: new shared `packages/gateway-bot/src/channel-http.ts`, ported from
hermes-agent (the canonical reference for channel patterns):
- `resolveProxyUrl(platformEnvVar, targetHosts)` ← hermes
  `gateway/platforms/base.py:resolve_proxy_url` — platform env (TELEGRAM_PROXY/
  DISCORD_PROXY) → HTTPS/HTTP/ALL_PROXY → Windows system proxy; honours NO_PROXY.
- `telegramFetch(url, init)` ← hermes `gateway/platforms/telegram_network.py:
  TelegramFallbackTransport` — proxy wins; else primary path (undici 250ms cap
  lifted to 3s); else SNI-preserving IP fallback (curl --resolve equivalent) to
  IPs from env (TELEGRAM_FALLBACK_IPS) → DoH (Google+Cloudflare) + system DNS →
  hardcoded seed, sticky to first working IP. Opt-out:
  MEMEX_TELEGRAM_DISABLE_FALLBACK_IPS.
- `channelDispatcher(platformEnvVar, targetHosts)` for generic per-channel proxy.
Telegram + Discord adapters route through it. Telegram long-poll also got
exponential backoff + log de-dup + ok:false handling.

**Reference**: hermes-agent specimen at `D:/Repo/specimens/hermes-agent`,
`gateway/platforms/` has 20+ channel adapters (signal, matrix, slack, whatsapp,
feishu, wecom, dingtalk, sms, bluebubbles, homeassistant…). MOST ARE NOT YET
PORTED here — when adding a new HTTP channel, copy hermes's pattern and route
through channel-http.ts rather than calling fetch() directly. See [[project_phase12_complete]]
(connector-matrix) for what already exists. Live bot: @memememex_bot (token in
repo .env). 12 unit tests (8 channel-http + 4 telegram); gateway-bot suite 62 green.
