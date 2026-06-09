<!-- generated-by: gsd-doc-writer -->
# Configuration

This guide covers all configuration points for the Graph-Native Agent Runtime: environment variables, the iii Engine YAML config, Docker Compose service settings, and per-package notes.

---

## Environment Variables

All environment variables are loaded from a `.env` file in the project root at startup. The `scripts/dev.mjs` dev launcher reads `.env` directly and injects its values into every child process.

Copy `.env.example` to `.env` before first run:

```bash
cp .env.example .env
```

### Required Variables

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Must point to a database with the pgvector extension. | `postgres://postgres:password@localhost:5432/graph_test` |
| `III_URL` | WebSocket URL of the iii Engine worker bus. Workers and the Control Plane both connect to this address. | `ws://localhost:4001` |

Both variables have code-level fallbacks (`postgres://localhost:5432/graph` and `ws://localhost:49134` respectively), but those fallbacks target ports that differ from the Docker Compose and iii-config.yaml defaults. Set these explicitly to avoid mismatches.

### Optional Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port for the Gateway (Hono/Bun). The `.env.example` sets this to `4000`, which is the intended development value. |
| `LOG_LEVEL` | `info` | Pino log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Set to `debug` for full hash-chain visibility. |
| `LLM_API` | `openai-completions` | LLM provider protocol. Accepted values: `openai-completions` (OpenAI, Ollama, vLLM, LM Studio, DeepSeek) or `anthropic-messages` (Anthropic Messages API). |
| `LLM_BASE_URL` | `http://localhost:11434` | Base URL for the LLM endpoint. For Ollama, this is the default Ollama address. For OpenAI, use `https://api.openai.com`. |
| `LLM_MODEL` | `llama3` | Model identifier passed to the LLM provider. Examples: `llama3`, `gpt-4o`, `claude-opus-4-5`. |
| `LLM_API_KEY` | `""` (empty string) | API key for the LLM provider. Required for cloud providers (OpenAI, Anthropic). Leave empty or set to a placeholder for local Ollama. |
| `LLM_MAX_TOKENS` | _(provider default)_ | Maximum output tokens per LLM call. When unset, the provider's own default applies. |
| `EMBEDDING_MODEL` | Falls back to `LLM_MODEL` | Model used exclusively for embedding generation. The embedding path always uses the `openai-completions` protocol regardless of `LLM_API`, because Anthropic has no embeddings endpoint. |
| `CONTEXT_W_MAX` | `4096` | Context window token budget (W_MAX). Controls how many tokens the Gateway assembles into a scope context projection. |
| `GRAPH_RUNTIME_SECRET` | _(none)_ | When set, the `POST /pair/generate` admin endpoint requires a `Bearer <secret>` `Authorization` header. When unset, the endpoint is open. |
| `REQUIRE_AGENT_PAIRING` | `false` | Set to `true` to require paired agents on all MCP endpoints (`/mcp`, `/mcp/sse`, `/mcp/messages`). Pairing is established via `POST /pair`. Single-process mode only. |
| `EXECUTE_BASH_ENABLED` | `false` | Set to `true` to enable the `execute_bash` MCP tool, which lets connected agents run shell commands on the host. Gated by CommandGate (hardline and dangerous commands are always blocked). |
| `EXECUTE_BASH_CWD` | System temp directory | Working directory for `execute_bash` commands. Only relevant when `EXECUTE_BASH_ENABLED=true`. |
| `MCP_SERVER_URLS` | _(none)_ | Comma-separated list of external MCP server URLs. The `McpClientWorker` connects to each at boot and registers their tools as iii worker functions (e.g., `graph::mcp-ext::<host>::<tool_name>`). |
| `NOTIFY_WEBHOOK_URL` | _(none)_ | Incoming webhook URL (Discord or Slack format). When set, the runtime posts a notification on Crystal and Lesson save events. No-op when unset. |
| `GRAPH_RUNTIME_URL` | `http://localhost:4000` | Used by the Pi Terminal extension to locate the Gateway's MCP endpoint. Set this if the Gateway runs on a non-default host or port. |

### Gateway-Bot Variables (optional, `@graph/gateway-bot`)

The gateway-bot package is an optional messaging interface. None of these variables are required for the core runtime.

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | _(none)_ | Telegram Bot API token. When set, the bot starts in long-poll mode (or webhook mode if `TELEGRAM_WEBHOOK_URL` is also set). |
| `TELEGRAM_WEBHOOK_URL` | _(none)_ | Public HTTPS URL for Telegram webhook delivery. When set alongside `TELEGRAM_BOT_TOKEN`, the bot registers a webhook and listens on port `4002`. |
| `DISCORD_BOT_TOKEN` | _(none)_ | Discord bot token. Required together with `DISCORD_APPLICATION_ID` to enable the Discord adapter. |
| `DISCORD_APPLICATION_ID` | _(none)_ | Discord application ID. Required together with `DISCORD_BOT_TOKEN`. |
| `DISCORD_PUBLIC_KEY` | _(none)_ | Discord application public key (Ed25519, hex-encoded). Used to verify interaction signatures. |
| `DISCORD_PORT` | `4001` | Port the Discord interactions HTTP server listens on. |

---

## iii Engine Configuration (`iii-config.yaml`)

The iii Engine worker bus is configured via `iii-config.yaml` in the project root. Start the engine with:

```bash
iii -c iii-config.yaml
```

The current configuration activates the following workers:

```yaml
workers:
  - name: iii-worker-manager
    config:
      port: 4001              # WebSocket port — must match III_URL

  - name: iii-cron
    config:
      adapter:
        name: kv              # In-process KV store for cron state

  - name: iii-observability
    config:
      enabled: true
      exporter: memory
      logs_enabled: true
      logs_console_output: true
      sampling_ratio: 0.1     # Full sampling (1.0) caused a 137 GB log loop — keep at 0.1

  - name: iii-queue
    config:
      adapter:
        name: builtin         # Required for durable:subscriber topic routing

  - name: iii-pubsub
    config:
      adapter:
        name: local           # Required for durable:subscriber delivery

  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: .iii-state   # Persistent KV file for trigger registration
```

**Key notes:**
- `iii-worker-manager` port (`4001`) must match the port component of `III_URL`.
- `iii-queue` and `iii-pubsub` adapters (`builtin` and `local`) are required for the Workers package's `durable:subscriber` topic routing to work correctly. Do not change these adapters without also updating the Workers registration.
- The `iii-exec` block is intentionally disabled. See the inline comment in `iii-config.yaml` for the full explanation.

---

## Docker Compose — PostgreSQL Service

The `docker-compose.yml` at the project root defines a single PostgreSQL service:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: password
      POSTGRES_DB: graph_test
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d graph_test"]
      interval: 2s
      timeout: 5s
      retries: 20
```

The image is `pgvector/pgvector:pg16`, which bundles both `pgvector` (vector similarity search) and the standard PostgreSQL 16 distribution. The `pgcrypto` extension required for hash computation is part of standard PostgreSQL and available in this image.

The default credentials (`postgres` / `password`) produce the connection string shown in `.env.example`:

```
DATABASE_URL=postgres://postgres:password@localhost:5432/graph_test
```

Manage the database with the root-level npm scripts:

```bash
npm run db:up        # docker compose up -d
npm run db:down      # docker compose down
npm run db:migrate   # run migrations (tsx scripts/migrate.ts)
npm run db:reset     # down -v + up + migrate (destructive)
```

---

## Per-Package Configuration Notes

### `@graph/gateway` (Hono, Bun runtime)

- Reads: `DATABASE_URL`, `PORT`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `CONTEXT_W_MAX`, `GRAPH_RUNTIME_SECRET`, `REQUIRE_AGENT_PAIRING`, `EXECUTE_BASH_ENABLED`, `EXECUTE_BASH_CWD`.
- The Gateway maintains a **SELECT/INSERT-only** PostgreSQL pool (no DDL rights per ADR 24). DDL operations are exclusively delegated to the Control Plane via a separate DDL pool.
- Default `PORT` fallback in code is `3000`. The `.env.example` sets `PORT=4000`. The dev launcher (`scripts/dev.mjs`) reads `PORT` from `.env` and applies it — always set `PORT` in `.env` to avoid the code-level `3000` fallback.
- The `LLM_*` variables configure the Gateway's own LLM provider instance, used by the memory route (`/v1/memory`). This is separate from the Workers package LLM provider.

### `@graph/workers` (Node.js + tsx/esm)

- Reads: `III_URL`, `DATABASE_URL`, `LLM_API`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_MAX_TOKENS`, `EMBEDDING_MODEL`, `MCP_SERVER_URLS`, `NOTIFY_WEBHOOK_URL`.
- All Workers are registered at this single boot entry point. No Worker module reads `process.env` directly — credentials are injected as constructor arguments (ADR 22).
- `LLM_API` selects the provider protocol: `openai-completions` (default) or `anthropic-messages`. The embedding provider always uses `openai-completions` regardless of `LLM_API`.
- `MCP_SERVER_URLS` is a comma-separated list. Each URL is connected at boot; tools from each server are registered as iii worker functions under the `graph::mcp-ext::<host>::<tool>` naming scheme.

### `@graph/control-plane` (Node.js + tsx/esm)

- Reads: `DATABASE_URL`, `III_URL`.
- No LLM configuration — the Control Plane performs no LLM calls. It runs the Pulse-Fetch bridge (PostgreSQL `LISTEN`/`NOTIFY` → iii triggers) and the Convergence Watchdog.

### `@graph/gateway-bot` (Node.js)

- Reads: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_PORT`.
- The bot is entirely optional. It is not started by `scripts/dev.mjs`. Start it separately if needed.

### `@graph/pi-extension`

- Reads: `GRAPH_RUNTIME_URL` (defaults to `http://localhost:4000`).
- This is a Pi Terminal extension, not a standalone process. It does not connect to the database directly.

### `@graph/cli`

- No environment variable reads. The CLI (`graph-runtime connect`) patches agent config files on the local filesystem and does not communicate with the runtime at startup.

---

## Development vs Production Configuration

### Development

Use `.env.example` as the starting point. The key development settings are:

```env
DATABASE_URL=postgres://postgres:password@localhost:5432/graph_test
III_URL=ws://localhost:4001
PORT=4000
LOG_LEVEL=debug
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=llama3
LLM_API_KEY=placeholder
```

- `LOG_LEVEL=debug` enables full hash-chain visibility in log output.
- A local Ollama instance at `http://localhost:11434` is the standard development LLM. No real API key is needed.
- All services run on localhost with the ports managed by `scripts/dev.mjs`.

### Production

<!-- VERIFY: production deployment platform and secret management approach -->

For production deployments, replace development defaults with the following:

- **`DATABASE_URL`** — point to your production PostgreSQL instance (must have `pgvector` and `pgcrypto`).
- **`LLM_API_KEY`** — set to a real API key for your cloud LLM provider.
- **`LLM_BASE_URL`** — set to the cloud provider endpoint (e.g., `https://api.openai.com` for OpenAI, or omit for Anthropic when `LLM_API=anthropic-messages`).
- **`LLM_MODEL`** — set to the production model identifier.
- **`LOG_LEVEL`** — use `info` or `warn` to reduce log volume; avoid `debug` in production.
- **`GRAPH_RUNTIME_SECRET`** — set to a strong random string to protect the `/pair/generate` admin endpoint.
- **`REQUIRE_AGENT_PAIRING`** — consider setting to `true` to restrict MCP access to paired agents only.
- **`EXECUTE_BASH_ENABLED`** — leave unset (defaults to `false`) unless host command execution is explicitly required.
- **`NOTIFY_WEBHOOK_URL`** — set to a Discord or Slack incoming webhook URL to receive Crystal and Lesson event notifications.

<!-- VERIFY: database connection pool sizing recommendations for production workloads -->
