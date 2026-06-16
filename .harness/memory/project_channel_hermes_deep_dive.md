---
name: project_channel_hermes_deep_dive
description: "Channel connectivity deep-dive — hermes 3 transport families, DRY port plan, UX spec deliverable"
metadata: 
  node_type: memory
  type: project
  originSessionId: ce065d28-6967-4ae2-8256-90e924fe9b18
---

2026-06-13 (/goal): authored `docs/guides/channel-connectivity-hermes-deep-dive.md` —
authoritative analysis of how hermes-agent connects all 20 external channels, mapped to our gateway-bot, with DRY port plan + UI/UX spec.

**Core finding:** hermes's 20 adapters = **3 transport families** (not 20 problems):
- **A. Outbound-initiated** (long-poll/WS/SSE — Telegram, Slack Socket Mode, DingTalk, Matrix, Feishu, QQ, HomeAssistant, Signal, Email IMAP, Weixin, YuanBao): no public URL, GFW/NAT-friendly. **Prefer when offered.**
- **B. Inbound webhook** (WhatsApp, SMS, BlueBubbles, WeCom, MSGraph, generic, Discord interactions): needs public URL + ONE shared HTTP host (hermes `webhook.py`/`api_server.py` registers `POST /webhooks/{route}`, not per-adapter servers).
- **C. Local-daemon bridge** (Signal=signal-cli, BlueBubbles=macOS server): hit 127.0.0.1 sidecar.

**DRY seam status** (don't reinvent — port hermes's shared helpers):
- ✅ `resolveProxyUrl` ported (channel-http.ts), ✅ `telegramFetch` IP-fallback ported.
- ❌ GAP: SOCKS proxy + rdns (hermes `proxy_kwargs_for_bot`) — no socks dep, real for CN/Clash users.
- ❌ GAP: shared inbound webhook host; self-healing reconnect (exp backoff+jitter) — our connectors `start()` but don't reconnect.

**UX thesis:** the channel-connectivity bug (valid token + unreachable net → "pairing failed") = the design problem. Settings Channels panel only shows config-presence, never runs `check()` / renders `check.detail`. Spec'd 4-state pill (Connected/Configured-not-connected/Needs-setup/Error) shared CLI+Dashboard, verbatim detail, per-family ChannelCard, "Test connection" exposing transport path.

**4 open decisions (need human, deliverable §7):** (1) add socks dep? (2) build shared webhook host now/on-demand? (3) next channel=Slack Socket Mode (recommended)? (4) signal-cli sidecar?

No code shipped — investigation+design goal, implementation gated on decisions. Related: [[project_channel_connectivity_fix]] (the bug that motivated this), [[project_phase12_complete]] (connector-matrix), [[project_ui_console_arc_complete]].
