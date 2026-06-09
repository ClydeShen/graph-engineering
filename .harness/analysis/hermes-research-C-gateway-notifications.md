# Hermes Agent Research — Part C: Multi-terminal Gateway & Notifications

## 1. Gateway Architecture (multi-platform bridging)

### The Single-Process, Multi-Adapter Model

The gateway is a single long-running Python asyncio process managed by `GatewayRunner` (`gateway/run.py:1676`). On startup, `start_gateway()` (`gateway/run.py:19043`) instantiates a `GatewayRunner`, which then iterates over every enabled platform in `GatewayConfig.platforms` and calls `_create_adapter()` (`gateway/run.py:6527`) for each one. Each adapter connects concurrently (within a timeout), and all live adapters are stored in `self.adapters: Dict[Platform, BasePlatformAdapter]` (`gateway/run.py:1704`). The single event loop services all platforms simultaneously.

### `Platform` Enum and Platform Registry

All platforms (built-in and plugin) are identified by the `Platform` enum (`gateway/config.py:100-193`). Built-in members include `TELEGRAM`, `DISCORD`, `WHATSAPP`, `SLACK`, `SIGNAL`, `MATTERMOST`, `MATRIX`, `HOMEASSISTANT`, `EMAIL`, `SMS`, `DINGTALK`, `FEISHU`, `WECOM`, `BLUEBUBBLES`, `QQBOT`, `YUANBAO`, `WEBHOOK`, `API_SERVER`, and others. Plugin platforms are dynamically added via `Platform._missing_()` (`gateway/config.py:131-173`) which scans `plugins/platforms/` and the `PlatformRegistry`.

The `PlatformRegistry` (`gateway/platform_registry.py:162`) is a module-level singleton (`platform_registry = PlatformRegistry()`, `gateway/platform_registry.py:260`) that holds `PlatformEntry` objects. Each `PlatformEntry` carries an `adapter_factory`, `check_fn`, `validate_config`, `setup_fn`, cron env var names, standalone sender hooks, and more (`gateway/platform_registry.py:38-159`). Plugin adapters under `plugins/platforms/` (e.g. Discord at `plugins/platforms/discord/adapter.py`, Teams at `plugins/platforms/teams/adapter.py`) self-register by calling `ctx.register_platform()` in their `register(ctx)` entry point.

### Adapter Base Class and Message Routing

All platform adapters inherit from `BasePlatformAdapter` (`gateway/platforms/base.py:1647`). The abstract interface requires:
- `connect() -> bool` — connect to the platform and start listeners
- `disconnect()` — tear down
- `send(chat_id, text, metadata)` — send a text message
- `send_image_file`, `send_document`, `send_voice`, `send_video` — media delivery

Inbound messages from every platform are normalized into a `MessageEvent` dataclass (`gateway/platforms/base.py:1289`) containing `text`, `message_type`, `source` (a `SessionSource`), `media_urls`, `reply_to_message_id`, and optional `auto_skill`/`channel_prompt` fields. Each adapter calls `self._message_handler(event)` which routes to `GatewayRunner._handle_message()` (`gateway/run.py:4365`). The handler builds or retrieves an `AIAgent` for the session, then dispatches to the LLM and returns the response to the originating adapter.

### `_create_adapter` Dispatch Chain

`_create_adapter()` (`gateway/run.py:6527`) first checks `platform_registry.is_registered(platform.value)` and delegates to the registry's `create_adapter()` if a plugin is registered. Only if the registry has no entry does it fall through to the built-in if/elif chain (`gateway/run.py:6572`+):
- `Platform.TELEGRAM` → `TelegramAdapter` from `gateway/platforms/telegram.py`
- `Platform.WHATSAPP` → `WhatsAppAdapter` from `gateway/platforms/whatsapp.py`
- `Platform.SLACK` → `SlackAdapter` from `gateway/platforms/slack.py`
- `Platform.SIGNAL` → `SignalAdapter` from `gateway/platforms/signal.py`
- `Platform.HOMEASSISTANT` → `HomeAssistantAdapter` from `gateway/platforms/homeassistant.py`
- `Platform.EMAIL` → `EmailAdapter` from `gateway/platforms/email.py`
- Discord is handled entirely via the plugin at `plugins/platforms/discord/adapter.py`

### Platform Coverage Map

| Platform | Adapter Location | Transport |
|---|---|---|
| Telegram | `gateway/platforms/telegram.py` | Long polling or webhook (TELEGRAM_WEBHOOK_URL) |
| Discord | `plugins/platforms/discord/adapter.py` | discord.py (WebSocket + intents) |
| Slack | `gateway/platforms/slack.py` | Socket Mode (slack-bolt) |
| WhatsApp | `gateway/platforms/whatsapp.py` | Node.js bridge subprocess (whatsapp-web.js or Baileys) |
| Signal | `gateway/platforms/signal.py` | SSE from signal-cli HTTP daemon |
| Matrix | `gateway/platforms/matrix.py` | mautrix (WebSocket) |
| Home Assistant | `gateway/platforms/homeassistant.py` | HA WebSocket API (`state_changed` events) |
| Email | `gateway/platforms/email.py` | IMAP polling + SMTP send |
| SMS | `gateway/platforms/sms.py` | Twilio API |
| DingTalk | `gateway/platforms/dingtalk.py` | DingTalk SDK |
| Feishu (Lark) | `gateway/platforms/feishu.py` | Feishu event callback webhook |
| WeCom | `gateway/platforms/wecom.py` | WeCom bot webhook |
| Weixin | `gateway/platforms/weixin.py` | Weixin token-based API |
| BlueBubbles (iMessage) | `gateway/platforms/bluebubbles.py` | BlueBubbles REST/WebSocket bridge |
| Teams | `plugins/platforms/teams/adapter.py` | Plugin |
| IRC | `plugins/platforms/irc/` | Plugin |
| Mattermost | `plugins/platforms/mattermost/` | Plugin |
| Ntfy | `plugins/platforms/ntfy/` | Plugin |
| SimplexChat | `plugins/platforms/simplex/` | Plugin |
| Google Chat | `plugins/platforms/google_chat/` | Plugin |
| LINE | `plugins/platforms/line/` | Plugin |

---

## 2. Setting up a New Platform Connection (e.g., Telegram)

### Interactive Setup: `hermes gateway setup`

The entry point is `gateway_setup()` (`hermes_cli/gateway.py:5434`). It:
1. Displays a menu of all platforms (built-in `_PLATFORMS` list + plugin-discovered entries via `_all_platforms()`).
2. For each chosen platform, calls `_configure_platform()` (`hermes_cli/gateway.py:5390`).
3. `_configure_platform` dispatches to: a plugin-provided `setup_fn`, a built-in setup function, or `_setup_standard_platform()` which walks through the platform's `vars` list and prompts for each env var.
4. After configuration, offers to restart/install the gateway service.

### Telegram Example (fully documented in code)

The Telegram `_PLATFORMS` entry (`hermes_cli/gateway.py:3615-3648`) defines:
- **Setup instructions:** Message `@BotFather`, run `/newbot`, copy the bot token; message `@userinfobot` for your numeric user ID.
- **Env vars prompted:**
  - `TELEGRAM_BOT_TOKEN` — the bot token from BotFather (password field)
  - `TELEGRAM_ALLOWED_USERS` — comma-separated allowlist of numeric user IDs
  - `TELEGRAM_HOME_CHANNEL` — chat ID for cron delivery (optional; can be set later via `/sethome` in chat)

The env vars are stored in `~/.hermes/.env`. On next gateway start, `load_gateway_config()` (`gateway/config.py:695`) reads `~/.hermes/config.yaml` and falls back to `.env` via `_apply_env_overrides()` (`gateway/config.py:1248`), which calls `_enable_from_env(Platform.TELEGRAM)` and sets `telegram_config.token = telegram_token` (`gateway/config.py:1263-1266`).

### Telegram: Polling vs. Webhook

`TelegramAdapter.connect()` (`gateway/platforms/telegram.py:1489`) documents both modes:
- **Default — long polling:** Calls `self._app.updater.start_polling(...)` (`gateway/platforms/telegram.py:1121`). PTB (`python-telegram-bot`) opens an outbound HTTPS connection to `api.telegram.org`.
- **Webhook mode** (set `TELEGRAM_WEBHOOK_URL`): Calls `self._app.updater.start_webhook(port=..., url_path=..., webhook_url=..., secret_token=...)` (`gateway/platforms/telegram.py:1679-1688`). The env vars are:
  - `TELEGRAM_WEBHOOK_URL` — public HTTPS URL (e.g. `https://app.fly.dev/telegram`)
  - `TELEGRAM_WEBHOOK_PORT` — local listen port (default 8443)
  - `TELEGRAM_WEBHOOK_SECRET` — HMAC verification token (required; logged as warning if absent)

### Slack Setup

Slack (`hermes_cli/gateway.py:3652-3693`) requires:
1. Create a Slack app with Socket Mode enabled, generate an App-Level Token (`xapp-...`), add bot OAuth scopes, subscribe to events.
2. Env vars: `SLACK_BOT_TOKEN` (`xoxb-...`), `SLACK_APP_TOKEN` (`xapp-...`), optionally `SLACK_ALLOWED_USERS`.
3. The `SlackAdapter` (`gateway/platforms/slack.py`) uses `slack-bolt`'s `AsyncSocketModeHandler` — no inbound port needed; the bot maintains a persistent WebSocket to Slack's infrastructure.

### Signal Setup

Signal requires a local `signal-cli` daemon (`gateway/platforms/signal.py:1-12`):
- Run `signal-cli daemon --http 127.0.0.1:8080` (or similar).
- Set `SIGNAL_HTTP_URL` and `SIGNAL_ACCOUNT` env vars (`gateway/config.py:1365-1373`).
- The adapter subscribes via SSE (Server-Sent Events) and sends via JSON-RPC 2.0 over HTTP.

### Home Assistant Setup

`HomeAssistantAdapter` (`gateway/platforms/homeassistant.py:51`) requires:
- `HASS_TOKEN` — a Long-Lived Access Token from HA.
- `HASS_URL` — defaults to `http://homeassistant.local:8123`.
- Connects via the HA WebSocket API, subscribes to `state_changed` events.

### WhatsApp Setup

`WhatsAppAdapter` (`gateway/platforms/whatsapp.py:1-16`) uses a Node.js subprocess bridge (whatsapp-web.js or Baileys). The adapter spawns and manages the bridge process; authentication is handled by the bridge (QR-code scan for personal accounts, or Meta Business verification for the Business API). Enabled via `WHATSAPP_ENABLED=true` (`gateway/config.py:1315`).

### Email Setup

Email (`gateway/platforms/email.py`) requires four env vars (`gateway/config.py:1443-1455`):
- `EMAIL_ADDRESS`, `EMAIL_PASSWORD`, `EMAIL_IMAP_HOST`, `EMAIL_SMTP_HOST`.
- Polls IMAP for new messages; sends via SMTP.

### Setting the Home Channel (`/sethome`)

After the gateway is running, typing `/sethome` in any chat calls `_handle_set_home_command()` (`gateway/run.py:11563`). This:
1. Reads `source.platform`, `source.chat_id`, `source.thread_id` from the inbound event.
2. Resolves the platform's home env var name via `_home_target_env_var(platform_name)`.
3. Calls `save_env_value(env_key, str(chat_id))` — writes to `~/.hermes/.env`.
4. Also updates the live `GatewayConfig` in-memory so delivery routing picks it up immediately without a restart (`gateway/run.py:11586-11596`).

---

## 3. Conversation Continuity Across Platforms

### Session Keys

Every incoming `MessageEvent` carries a `SessionSource` dataclass (`gateway/session.py:71`) with fields: `platform`, `chat_id`, `chat_type` (`"dm"`, `"group"`, `"channel"`, `"thread"`), `user_id`, `thread_id`, `guild_id`, `parent_chat_id`, and others.

A deterministic session key is produced by `build_session_key()` (`gateway/session.py:600`):
- **DM:** `agent:main:{platform}:dm:{chat_id}` (or with `thread_id` appended if set)
- **Group:** `agent:main:{platform}:{chat_type}:{chat_id}[:{thread_id}][:{user_id}]` depending on `group_sessions_per_user` and `thread_sessions_per_user` config flags.

Sessions are **scoped to platform**. A Telegram DM and a Slack DM from the same user are completely separate sessions; there is no cross-platform session continuity in the current design.

### Session Store

`SessionStore` (`gateway/session.py:668`) maintains an in-memory `Dict[str, SessionEntry]` and persists to SQLite via `SessionDB` (with a JSONL fallback). Each `SessionEntry` (`gateway/session.py:424`) maps `session_key → session_id`, stores `origin` metadata (for cron delivery routing), and tracks token usage.

### Session Isolation Modes

- `group_sessions_per_user: bool = True` — default; each user in a group/channel gets their own per-user session.
- `thread_sessions_per_user: bool = False` — default; threads are shared across all participants (the entire thread sees one conversation). Overridable in `config.yaml` (`gateway/config.py:487-491`).

### Reset Policy

`SessionResetPolicy` (`gateway/config.py:237`) defines when sessions auto-reset:
- `mode`: `"daily"` (at a configured hour), `"idle"` (after N minutes), `"both"` (whichever fires first), or `"none"`.
- Defaults: `mode="both"`, `at_hour=4`, `idle_minutes=1440` (24h).
- Reset notifications are sent to the user unless the platform is in `notify_exclude_platforms` (default: `api_server`, `webhook`).

### Session Context Prompt Injection

At each agent invocation, `build_session_context_prompt()` (`gateway/session.py:231`) assembles a system prompt section that tells the agent:
- The source platform and chat description.
- All connected platforms with their status.
- All configured home channels for cron/delivery targeting.
- Available `deliver=` options for scheduled tasks.

This gives the agent full awareness of the multi-platform topology from within any single session.

---

## 4. Cross-platform Notification Delivery

### Cron/Scheduler Architecture

The cron scheduler lives in `cron/scheduler.py`. The gateway calls `tick()` every 60 seconds from a background thread. `tick()` acquires a file-based lock at `~/.hermes/cron/.tick.lock` to prevent concurrent runs (`cron/scheduler.py:1-11`), then calls `get_due_jobs()` from `cron/jobs.py` to load `~/.hermes/cron/jobs.json` and find jobs whose `next_run` has passed.

Jobs are stored as dicts in `~/.hermes/cron/jobs.json` (`cron/jobs.py:39`). Each job has:
- `id`, `name`, `prompt` (the task description for the agent)
- `schedule` (cron expression, parsed by `croniter`)
- `deliver` — delivery target string (see below)
- `origin` — where the job was created (`{platform, chat_id, thread_id}`)
- `enabled_toolsets`, `profile`, etc.

### Delivery Target Resolution

The `deliver` field is a string that can be:
- `"local"` — save to `~/.hermes/cron/output/` only
- `"origin"` — send back to the chat/thread where the job was created
- `"telegram"` — send to Telegram home channel (from `TELEGRAM_HOME_CHANNEL` env var)
- `"telegram:123456789"` — explicit Telegram chat ID
- `"telegram:-100123:17"` — explicit chat + thread ID
- Comma-separated combinations: `"origin,telegram"`, `"all"` (all platforms with a configured home channel)

Resolution is done by `_resolve_delivery_targets()` (`cron/scheduler.py:517`) → `_resolve_single_delivery_target()` (`cron/scheduler.py:386`). The `_HOME_TARGET_ENV_VARS` dict (`cron/scheduler.py:124-140`) maps platform names to their env var names:

```
"telegram": "TELEGRAM_HOME_CHANNEL"
"discord":  "DISCORD_HOME_CHANNEL"
"slack":    "SLACK_HOME_CHANNEL"
"signal":   "SIGNAL_HOME_CHANNEL"
"matrix":   "MATRIX_HOME_ROOM"
"email":    "EMAIL_HOME_ADDRESS"
"whatsapp": "WHATSAPP_HOME_CHANNEL"
...
```

Plugin platforms expose their home channel env var via `PlatformEntry.cron_deliver_env_var` (`gateway/platform_registry.py:142`).

### Actual Delivery: `_deliver_result()`

`_deliver_result()` (`cron/scheduler.py:618`) loops over all resolved targets. For each target:

1. **Live adapter path (preferred):** If the gateway is running in the same process and `adapters` + `loop` are available, it calls `runtime_adapter.send(chat_id, text, metadata=send_metadata)` via `safe_schedule_threadsafe()` (`cron/scheduler.py:726-773`). This works for E2EE platforms (Matrix) that cannot be accessed without the live connection.

2. **Standalone path (fallback):** Calls `_send_to_platform(platform, pconfig, chat_id, content, thread_id=thread_id, media_files=media_files)` from `tools/send_message_tool.py` via `asyncio.run()` (or a thread if a loop is already running, `cron/scheduler.py:782-793`). Standalone senders for plugin platforms can be registered via `PlatformEntry.standalone_sender_fn` (`gateway/platform_registry.py:157-159`).

### Media Delivery from Cron Jobs

If the cron agent's output contains `MEDIA:<path>` tags or bare file paths, `BasePlatformAdapter.extract_media()` strips them, and `_send_media_via_adapter()` (`cron/scheduler.py:562`) routes each file to the correct adapter method:
- Audio extensions → `adapter.send_voice()` or `adapter.send_audio()`
- Video extensions → `adapter.send_video()`
- Image extensions → `adapter.send_image_file()`
- Everything else → `adapter.send_document()`

### General Notification Abstraction: `DeliveryRouter`

`DeliveryRouter` (`gateway/delivery.py:175`) is instantiated in `GatewayRunner.__init__()` (`gateway/run.py:1727`). It holds `config: GatewayConfig` and `adapters: Dict[Platform, Any]`. Its `deliver()` coroutine (`gateway/delivery.py:195`) accepts a list of `DeliveryTarget` objects and dispatches:
- `Platform.LOCAL` → `_deliver_local()` — writes a markdown file to `~/.hermes/cron/output/`
- Any other platform → `_deliver_to_platform()` — resolves the adapter and calls `send()`

`DeliveryTarget.parse()` (`gateway/delivery.py:112`) is the string-to-target parser, handling `"origin"`, `"local"`, `"telegram"`, `"telegram:123456"`, and `"telegram:123456:17"` formats.

### Silent Output Suppression

Both `DeliveryRouter` (`gateway/delivery.py:292`) and the gateway's outbound path respect a `filter_silence_narration` config flag (default `True`). Messages that are *only* a silence marker (`*(silent)*`, `🔇`, a bare `.`, etc.) are dropped pre-send (`gateway/delivery.py:30-50`).

### Cron Job Wrapping

Delivered content is optionally wrapped with a header (`cron/scheduler.py:650-661`):
```
Cronjob Response: {task_name}
(job_id: {job_id})
-------------

{content}

To stop or manage this job, send me a new message (e.g. "stop reminder {task_name}").
```
Wrapping is on by default; set `cron.wrap_response: false` in `config.yaml` to disable.

---

## Citation Index

| Reference | Location |
|---|---|
| `BasePlatformAdapter` class definition | `gateway/platforms/base.py:1647` |
| `MessageEvent` dataclass | `gateway/platforms/base.py:1289` |
| `Platform` enum | `gateway/config.py:100` |
| `Platform._missing_()` — dynamic plugin member creation | `gateway/config.py:131` |
| `Platform._scan_bundled_plugin_platforms()` | `gateway/config.py:176` |
| `HomeChannel` dataclass | `gateway/config.py:203` |
| `SessionResetPolicy` dataclass | `gateway/config.py:237` |
| `PlatformConfig` dataclass | `gateway/config.py:281` |
| `GatewayConfig.get_connected_platforms()` | `gateway/config.py:505` |
| `load_gateway_config()` — config loading priority | `gateway/config.py:695` |
| `_apply_env_overrides()` — env var to config bridge | `gateway/config.py:1248` |
| Telegram token env override | `gateway/config.py:1263` |
| WhatsApp WHATSAPP_ENABLED env handling | `gateway/config.py:1315` |
| Signal env var handling | `gateway/config.py:1365` |
| Home Assistant env var handling | `gateway/config.py:1432` |
| Email env var handling | `gateway/config.py:1443` |
| `PlatformEntry` dataclass (registry entry) | `gateway/platform_registry.py:38` |
| `cron_deliver_env_var` field | `gateway/platform_registry.py:142` |
| `standalone_sender_fn` field | `gateway/platform_registry.py:157` |
| `PlatformRegistry` class | `gateway/platform_registry.py:162` |
| `platform_registry` singleton | `gateway/platform_registry.py:260` |
| `GatewayRunner` class | `gateway/run.py:1676` |
| `GatewayRunner.__init__()` — adapters dict, session store, delivery router | `gateway/run.py:1701` |
| `DeliveryRouter` instantiation | `gateway/run.py:1727` |
| Adapter connect loop | `gateway/run.py:4349` |
| `_create_adapter()` — plugin registry first, then built-in chain | `gateway/run.py:6527` |
| Telegram adapter creation | `gateway/run.py:6572` |
| WhatsApp adapter creation | `gateway/run.py:6601` |
| Slack adapter creation | `gateway/run.py:6608` |
| Signal adapter creation | `gateway/run.py:6615` |
| Home Assistant adapter creation | `gateway/run.py:6622` |
| `_handle_set_home_command()` — /sethome implementation | `gateway/run.py:11563` |
| `start_gateway()` entry point | `gateway/run.py:19043` |
| `GatewayRunner` instantiation | `gateway/run.py:19196` |
| `TelegramAdapter` class | `gateway/platforms/telegram.py:334` |
| `TelegramAdapter.connect()` — polling vs. webhook | `gateway/platforms/telegram.py:1489` |
| Telegram webhook mode (TELEGRAM_WEBHOOK_URL) | `gateway/platforms/telegram.py:1646` |
| Telegram start_polling call | `gateway/platforms/telegram.py:1121` |
| `SignalAdapter` docstring — signal-cli SSE | `gateway/platforms/signal.py:1` |
| `HomeAssistantAdapter` class | `gateway/platforms/homeassistant.py:51` |
| HASS_URL/HASS_TOKEN config | `gateway/platforms/homeassistant.py:77` |
| Email adapter env vars | `gateway/platforms/email.py:1` |
| `SlackAdapter.check_slack_requirements()` — socket mode | `gateway/platforms/slack.py:79` |
| WhatsApp bridge approach | `gateway/platforms/whatsapp.py:1` |
| `SessionSource` dataclass | `gateway/session.py:71` |
| `build_session_key()` | `gateway/session.py:600` |
| `SessionStore` class | `gateway/session.py:668` |
| `SessionEntry` dataclass | `gateway/session.py:424` |
| `build_session_context_prompt()` — platform context injection | `gateway/session.py:231` |
| Connected platforms listed in session prompt | `gateway/session.py:377` |
| Delivery options in session prompt | `gateway/session.py:394` |
| `DeliveryTarget.parse()` | `gateway/delivery.py:112` |
| `DeliveryRouter.deliver()` | `gateway/delivery.py:195` |
| `_is_silence_narration()` | `gateway/delivery.py:38` |
| Cron lock and tick interval | `cron/scheduler.py:1` |
| `_KNOWN_DELIVERY_PLATFORMS` | `cron/scheduler.py:115` |
| `_HOME_TARGET_ENV_VARS` dict | `cron/scheduler.py:124` |
| `_get_home_target_chat_id()` | `cron/scheduler.py:329` |
| `_resolve_delivery_targets()` | `cron/scheduler.py:517` |
| `_deliver_result()` — live adapter then standalone | `cron/scheduler.py:618` |
| Live adapter send path | `cron/scheduler.py:726` |
| Standalone asyncio.run send path | `cron/scheduler.py:782` |
| Cron output wrapping | `cron/scheduler.py:650` |
| `_send_media_via_adapter()` | `cron/scheduler.py:562` |
| Jobs file path | `cron/jobs.py:39` |
| `_PLATFORMS` list (Telegram entry) | `hermes_cli/gateway.py:3615` |
| Telegram setup instructions in code | `hermes_cli/gateway.py:3621` |
| Slack setup instructions in code | `hermes_cli/gateway.py:3657` |
| `gateway_setup()` interactive setup entry point | `hermes_cli/gateway.py:5434` |
| `_configure_platform()` dispatch | `hermes_cli/gateway.py:5390` |
| `run_gateway()` foreground runner | `hermes_cli/gateway.py:3441` |
| `gateway/platforms/ADDING_A_PLATFORM.md` — plugin guide | `gateway/platforms/ADDING_A_PLATFORM.md:1` |
| Discord plugin adapter | `plugins/platforms/discord/adapter.py:1` |
| Teams plugin adapter | `plugins/platforms/teams/adapter.py` |
