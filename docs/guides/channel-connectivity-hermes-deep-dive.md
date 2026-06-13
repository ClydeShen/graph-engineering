# Channel Connectivity — Hermes Deep-Dive, DRY Port Plan & UX Spec

> Goal: understand *how hermes-agent successfully connects every external channel*,
> map it to our `gateway-bot`, port the proven pieces (DRY — do not reinvent), and
> optimize the pairing/onboarding system from a UI/UX perspective.
>
> Source of truth for hermes patterns: `D:/Repo/specimens/hermes-agent/gateway/platforms/`
> (`ADDING_A_PLATFORM.md`, `base.py`, `telegram_network.py`, `_http_client_limits.py`,
> `api_server.py`, plus 20 adapters). Read those before extending this.

---

## 1. The core insight — hermes has only THREE connection families

Twenty adapters look like twenty problems. They are not. Every channel reduces to
one of three transport families, and *the family — not the brand — decides the
connect mechanism, the firewall behaviour, and the pairing UX.* This is the single
most important thing to internalize before porting anything.

| Family | How it connects | Needs public URL? | GFW/NAT behaviour | hermes channels |
|---|---|---|---|---|
| **A. Outbound-initiated** (long-poll or persistent WS/SSE) | The bot *dials out* and holds a connection open; events arrive on it | **No** | Works behind NAT/firewall; only needs egress (+ proxy) | Telegram (long-poll), Slack (Socket Mode WS), DingTalk (stream WS), Matrix (sync loop), Feishu (long-conn WS), QQ (gateway WS), HomeAssistant (WS), Signal (SSE), Email (IMAP poll/IDLE), Weixin (reverse long-poll), YuanBao (proto WS) |
| **B. Inbound webhook** | The platform *calls us*; we run an HTTP server and register a route + verify signatures | **Yes** (public URL) | Needs ingress — tunnel/reverse-proxy required behind NAT | WhatsApp (Cloud API), SMS (Twilio), BlueBubbles, WeCom callback, MSGraph (Teams/Outlook), generic webhook, Discord interactions |
| **C. Local-daemon bridge** | Talk to a localhost helper process that owns the real protocol | No (daemon handles it) | Daemon handles connectivity; we just hit `127.0.0.1` | Signal (`signal-cli --http`), BlueBubbles (macOS server) |

**Consequences that drop straight out of this table:**

- Family A is **always preferable when a platform offers it** — no inbound URL, no
  tunnel, GFW-friendly. Telegram *and* Slack both offer it (long-poll / Socket Mode).
  That's why hermes defaults Telegram to long-poll and Slack to Socket Mode.
- Family B channels can **share one inbound HTTP server**. hermes does exactly this:
  `webhook.py` runs a single `aiohttp` app with `add_post("/webhooks/{route_name}")`
  and every webhook channel registers a *route*, not its own server
  (`api_server.py:4090` is the canonical shared app). **Build the shared host once.**
- Family C means "ship/spawn a sidecar," which is a deployment decision, not just code.

---

## 2. Per-channel connection mechanism (the detail map)

Extracted from each adapter's `connect()` and transport imports. `→ send` notes the
*outbound* path when it differs from inbound.

| Channel | Family | Inbound mechanism | Outbound / send | Auth / pairing | Notable resilience |
|---|---|---|---|---|---|
| **Telegram** | A | `getUpdates` long-poll (httpx pool); webhook optional | Bot API REST | bot token | `telegram_network.TelegramFallbackTransport`: SNI-preserving IP fallback + sticky IP; pool reset on wedged poll |
| **Slack** | A | Socket Mode `AsyncSocketModeHandler` (outbound WS) | Web API | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | `_restart_socket_mode` + heartbeat probe loop self-heals dead sockets (`slack.py:436-544`) |
| **DingTalk** | A | `dingtalk-stream` SDK (outbound WS stream) | session webhook (markdown) | app key/secret | SDK manages reconnect |
| **Matrix** | A | `nio.AsyncClient` login → `sync_forever` | client-server API | homeserver + access token; E2EE store on disk | proxy via `_create_matrix_session(proxy_url)` |
| **Feishu/Lark** | A (or B) | `lark_oapi` long-conn WS **or** `/feishu/webhook` | Lark API | app id/secret | WS preferred; webhook fallback |
| **QQ Bot** | A | gateway WebSocket | QQ API | app id/token | inline-keyboard interaction routing |
| **HomeAssistant** | A | `/api/websocket` auth + subscribe | REST `/api/...` | URL + long-lived token | dedicated REST session for sends |
| **Signal** | A + C | SSE from `signal-cli --http` daemon | JSON-RPC 2.0 to daemon | linked device (QR via signal-cli) | health-check before listen; per-recipient backoff on `NETWORK_FAILURE` |
| **Email** | A | IMAP poll/IDLE (`imaplib`) | SMTP (`smtplib`) | host/port/user/pass | RFC 2971 IMAP ID handshake |
| **Weixin (WeChat)** | A | reverse-engineered long-poll (`longpolling_timeout_ms`) | reverse API | session creds | server-suggested poll timeout |
| **YuanBao** | A | reverse-engineered protobuf over WS | proto | reverse creds | `yuanbao_proto` json/protobuf dual decode |
| **WhatsApp** | B | Meta Cloud API webhook (`verify_token`) | Graph REST | phone-number-id + access token | 24h session-window UX (`_keep_typing` override) |
| **SMS** | B | Twilio inbound webhook (signature-validated) | Twilio REST | account sid/auth + public `SMS_WEBHOOK_URL` | signature validation |
| **BlueBubbles** | B + C | inbound webhook from local macOS server | REST to local server | server URL + password | local server owns iMessage |
| **WeCom** | B | encrypted `aibot_msg_callback` (AES, `wecom_crypto`) | WeCom API | corp/agent id + token/aeskey | optional `openws` WS |
| **MSGraph** | B | Graph change-notification webhook | Graph REST | subscription + token | subscription renewal |
| **Generic webhook** | B | `POST /webhooks/{route_name}` shared route | configurable | per-route shared secret (`whsec_`) | the reference shared-host pattern |
| **Discord** | B (hermes: A gateway) | hermes uses `discord.py` gateway WS via `proxy_kwargs_for_bot`; **ours** uses inbound interactions webhook + Ed25519 | webhook / REST | bot token (+ intents) or app public key | — |

---

## 3. The shared transport seam — what hermes centralizes (and what we did/didn't port)

hermes refuses to duplicate transport concerns per adapter. Four shared helpers do
the heavy lifting. **This is the "don't reinvent the wheel" core.**

| hermes helper | What it solves | Our port status |
|---|---|---|
| `base.resolve_proxy_url(platform_env, target_hosts)` — platform env → `HTTPS/HTTP/ALL_PROXY` → system proxy; honours `NO_PROXY` | One proxy-resolution policy for all channels | ✅ **Ported** → `channel-http.ts:resolveProxyUrl` (macOS `scutil` → Windows registry) |
| `base.proxy_kwargs_for_bot/aiohttp` — **SOCKS support with `rdns=True`** | GFW users on Clash/Shadowrocket/SOCKS need remote DNS through the proxy | ❌ **GAP** — `channel-http.ts` only builds undici HTTP `ProxyAgent`; no SOCKS. Real for CN users. **Needs a dep decision** (`socks-proxy-agent`/undici socks dispatcher) |
| `telegram_network.TelegramFallbackTransport` — SNI-preserving IP fallback + DoH + sticky IP | Reach `api.telegram.org` when undici Happy-Eyeballs abandons a slow-but-working IPv4 | ✅ **Ported** → `channel-http.ts:telegramFetch` (this was last session's fix) |
| `_http_client_limits.platform_httpx_limits()` — tuned keepalive (`keepalive_expiry=2s`, `max_keepalive=10`) | fd-pressure when *many* long-lived adapter clients run at once | ❌ **Not ported** — only matters once we run several Family-A persistent connections. Low priority until then |

Two more cross-cutting patterns hermes bakes in that our connectors currently lack:

1. **Self-healing reconnect** — `ADDING_A_PLATFORM.md` mandates *"reconnection with
   exponential backoff + jitter for streaming connections."* Slack's restart loop and
   Telegram's pool-reset are concrete instances. Our `ConnectorRegistry.startAll`
   crash-isolates siblings (good) but the **connector itself doesn't reconnect** — a
   dropped Socket Mode / sync / SSE connection stays dead. This must live in each
   Family-A connector (or a shared `runWithReconnect()` wrapper).
2. **Plugin-path discipline** — hermes's *recommended* way to add a platform is a
   plugin dir with `plugin.yaml` + `adapter.py`, **zero core changes**. Our
   `ConnectorAdapter` contract + `ConnectorRegistry` is exactly that seam. **Rule:
   new channels are registered connectors; never edit core to add one.**

---

## 4. Our current state vs hermes — gap matrix

What we have in `packages/gateway-bot/src/`:

- **Contract:** `ConnectorAdapter` (frozen, Phase 11): `meta{platform, required_env,
  platform_hint, pii_safe}`, `check()`, `validateConfig()`, `start(onMessage, signal)`,
  `send(target, text)`. This is our `BasePlatformAdapter` equivalent — solid.
- **Registry:** `ConnectorRegistry` — `statusReport()` (env completeness + live
  `check()`), `startAll()` (graceful skip; matches hermes `check_fn` semantics).
- **Transport:** `channel-http.ts` — `resolveProxyUrl` + `channelDispatcher` +
  `telegramFetch`.
- **Adapters/connectors:** Telegram (long-poll + IP fallback), Discord (webhook +
  Ed25519), connector stubs for slack/email/webhook.
- **Routing:** `dispatchMessage` → gateway `/v1/scopes/:id/chat` → reply.

| Capability | hermes | us | Priority to close |
|---|---|---|---|
| Proxy resolution (HTTP) | ✅ | ✅ | — |
| SOCKS proxy + rdns (GFW) | ✅ | ❌ | **P0** (needs dep decision) |
| Telegram IP fallback | ✅ | ✅ | — |
| Shared inbound webhook host | ✅ (`webhook.py`/`api_server.py`) | ❌ (per-adapter Hono apps) | **P1** (unblocks all Family-B) |
| Self-healing reconnect (Family A) | ✅ | ❌ | **P1** |
| Tuned keepalive limits | ✅ | ❌ | P3 |
| Slack (Socket Mode) | ✅ | stub only | **P1** (Family A, GFW-friendly, high value) |
| Matrix / Signal / WhatsApp / SMS / WeCom / DingTalk / Feishu / QQ | ✅ | ❌ | P2, per demand |
| Setup wizard + status display | ✅ (`_PLATFORMS`, `hermes gateway status`) | partial (`statusReport`) | **P1** (UX, §6) |

---

## 5. DRY port plan (prioritized, each is "add a connector, don't touch core")

**P0 — transport completeness (benefits every current + future channel):**
1. **SOCKS proxy support** in `channel-http.ts`. Port `proxy_kwargs_for_bot`'s intent:
   when the resolved proxy URL is `socks*`, use a SOCKS dispatcher with remote DNS.
   *Decision needed from user:* add `socks-proxy-agent` (or equivalent) dependency.
   This is the one CN-network case we don't yet cover and our own Telegram fix would
   not have helped a SOCKS-only user.

**P1 — structural seams + first high-value channel:**
2. **Shared inbound webhook host.** Generalize the per-adapter Hono apps (e.g.
   `buildDiscordApp`) into one Hono app where each connector registers
   `POST /webhooks/:platform` + its own signature verifier — mirror `webhook.py`'s
   `add_post("/webhooks/{route_name}")`. Unblocks WhatsApp/SMS/WeCom/MSGraph at once.
3. **`runWithReconnect()` wrapper** (exp backoff + jitter) that Family-A connectors
   wrap their listen loop in. One implementation, reused by Telegram/Slack/Matrix/etc.
4. **Slack connector via Socket Mode** — outbound WS, no public URL, GFW-friendly,
   widely used. Best first new channel; exercises #3.

**P2 — fill the matrix on demand (each is a registered connector):**
5. Matrix (sync loop), Signal (local daemon — also decides sidecar packaging),
   WhatsApp/SMS (Family B, ride on #2), DingTalk/Feishu/QQ/WeCom as needed.

**P3 — polish:** port `platform_httpx_limits` once ≥3 persistent connections coexist.

> Many hermes adapters are **not yet ported** (signal, matrix, slack-live, whatsapp,
> feishu, wecom, dingtalk, qqbot, weixin, sms, bluebubbles, homeassistant, msgraph,
> yuanbao). Each should be a thin connector over the seams above — never a core edit.

---

## 6. UI/UX optimization — the pairing/onboarding system (designer lens)

The bug we fixed last session is the thesis statement for this section: **the token
was valid the whole time; the network was unreachable — but the UI said "pairing
failed."** A professional pairing UX never lies about *which layer* failed. Every
recommendation below serves that principle: *surface the true state, at the right
altitude, with the next action attached.*

### 6.1 Status taxonomy — one vocabulary, CLI + Dashboard
Replace binary "connected / not" with a 4-state pill, shared by `memex doctor` and the
Settings page (hermes parity — one status language everywhere):

- 🟢 **Connected** — `check()` ok *and* listen loop live.
- 🟡 **Configured, not connected** — env present, `check()` ok, loop not started/dropped.
- ⚪ **Needs setup** — required env missing (show exactly *which*, from `required_env`).
- 🔴 **Error** — `check()` failed; **render `check.detail` verbatim** ("getMe returned
  not-ok", "ETIMEDOUT — primary path unreachable, IP fallback also failed"). Our
  `statusReport()` already carries `detail`; the Settings page must **show it, not
  swallow it.** This single change would have prevented last session's confusion.

### 6.2 ChannelCard — progressive disclosure, not a wall of 20
Group by the §1 families and by readiness: **Connected · Available · Advanced.** One
reusable `ChannelCard`:
- Status pill (6.1) + channel name/emoji (hermes `_PLATFORMS` emoji/label).
- `required_env` rendered as labeled fields; secrets masked; inline validation from
  `validateConfig()`; copy-pasteable setup steps inline (hermes `setup_instructions`).
- Primary action sized to the transport family:
  - **Family A (token only):** a single **Connect** button. Lowest-friction path —
    lead with these (Telegram, Slack).
  - **Family B (webhook):** show the generated public webhook URL + secret with a
    **copy** button and a live **"waiting for first event…"** state that flips green on
    first verified inbound. Don't make users guess whether the platform reached us.
  - **Family C (daemon/QR):** embed the QR (Signal) and the "start the daemon" command;
    show daemon-reachable as its own sub-state.

### 6.3 "Test connection" — make the invisible transport visible
A **Test connection** button per card that runs `check()` and reports *the path used*:
direct / proxy(`<host>`) / Telegram IP-fallback(`sticky <ip>`). The diagnostics already
exist as log lines inside `telegramFetch` — promote them to a UI affordance. This turns
"it doesn't work" into "it connected via fallback IP 149.154.167.220 in 1.1s," which is
exactly what unblocked us last session.

### 6.4 Honesty & altitude rules (the through-line)
- Never collapse a **network** failure into a **credential** failure. Map error codes to
  human causes: `ETIMEDOUT/ENETUNREACH` → "Network can't reach `<host>` — check
  proxy/VPN," not "invalid token."
- Show the **layer**: auth ✓ / network ✗ as separate ticks, so the user knows the token
  is fine.
- Attach the **next action** to every red state ("Set `SLACK_APP_TOKEN`", "Start
  `signal-cli daemon`", "Add a proxy — see Advanced").

### 6.5 Scope discipline (matches our standing decision)
Keep this increment **read-only status + a single Test/Reconnect action** — high
leverage, safe. Defer write-CRUD for secrets/marketplace/cron until the
trust-isolation/ADR-47 review, per the existing deferral. Do **not** ship half-built
write surfaces.

---

## 7. Decisions that need a human (surfaced, not assumed)

1. **SOCKS dependency** (P0): add `socks-proxy-agent`/socks dispatcher to cover
   Clash/Shadowrocket SOCKS proxies? (hermes uses `aiohttp_socks`.) — *we have no socks
   dep today.*
2. **Shared webhook host** (P1): build the single Hono inbound host now, or wait until a
   Family-B channel is actually requested?
3. **Channel priority** (P2): which channels next? Recommended first = **Slack (Socket
   Mode)** — Family A, GFW-friendly, exercises the reconnect wrapper.
4. **Signal packaging** (P2): are we willing to ship/spawn a `signal-cli` sidecar
   (Family C), or keep Signal out of scope?

---

*Last updated: 2026-06-13. Reference specimen: `D:/Repo/specimens/hermes-agent`.*
