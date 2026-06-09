<!-- generated-by: gsd-doc-writer -->
# @graph/gateway-bot

Telegram and Discord messaging gateway for the Memex runtime. Receives inbound messages from both platforms, dispatches them into the Trail Mesh as `task_spawned` events, and replies with the spawned task ID.

Part of the [graph-enginerring](../../README.md) monorepo.

## What it does

- **Telegram** — supports two receive modes: long-polling (default, no infrastructure needed) and webhook (set `TELEGRAM_WEBHOOK_URL` to activate). Replies to each message with the spawned task ID.
- **Discord** — registers a `/graph` slash command on startup and serves interactions over a local HTTP port (default `4001`). Verifies Ed25519 request signatures from Discord before processing.
- Each inbound message writes an OCC-guarded `task_spawned` hyper-edge into the execution graph, keyed by a platform-scoped session key (`telegram::<chatId>` or `discord::<channelId>`).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | No | `postgres://localhost:5432/graph` | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | No* | — | Bot token from BotFather. Required to enable Telegram. |
| `TELEGRAM_WEBHOOK_URL` | No | — | Public HTTPS URL for the Telegram webhook endpoint. If absent, long-polling is used instead. |
| `DISCORD_BOT_TOKEN` | No* | — | Discord bot token. Required together with `DISCORD_APPLICATION_ID` to enable Discord. |
| `DISCORD_APPLICATION_ID` | No* | — | Discord application ID. Required together with `DISCORD_BOT_TOKEN`. |
| `DISCORD_PUBLIC_KEY` | No* | — | Discord application public key for Ed25519 signature verification. |
| `DISCORD_PORT` | No | `4001` | Local port the Discord interactions server listens on. |

\* At least one platform pair must be configured for the bot to do anything on startup.

## Running

```bash
# Install from monorepo root
npm install

# Start the gateway (reads env vars from the shell)
node --experimental-vm-modules src/index.ts
```

Or set credentials inline:

```bash
TELEGRAM_BOT_TOKEN=<token> DATABASE_URL=postgres://localhost:5432/graph \
  node --experimental-vm-modules src/index.ts
```

For Discord webhook mode, `DISCORD_PORT` must be reachable from the Discord interactions endpoint you configure in the developer portal.

## Telegram: long-poll vs webhook

| Mode | When | Port needed |
|---|---|---|
| Long-poll | `TELEGRAM_WEBHOOK_URL` is unset | No |
| Webhook | `TELEGRAM_WEBHOOK_URL` is set | Yes — listens on port `4002` at `POST /telegram/webhook` |

## Testing

```bash
npm test --workspace=packages/gateway-bot
```
