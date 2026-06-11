<!-- generated-by: gsd-doc-writer -->
# Deployment

This guide covers deploying the Graph-Native Agent Runtime to a production environment: prerequisites, database setup, service startup order, environment configuration, health verification, process management, and upgrade procedure.

---

## Prerequisites

Before deploying, ensure the following are available on the target host.

### Runtimes

| Dependency | Version | Purpose |
|---|---|---|
| Node.js | >= 18.0.0 (LTS recommended) | Workers, Control Plane |
| Bun | Latest stable | Gateway (`@graph/gateway`) |
| tsx | 4.22.4 (installed via npm) | ESM TypeScript runner for Workers and Control Plane |

### PostgreSQL

The runtime requires **PostgreSQL 16+** with two extensions:

- **pgcrypto** — SHA-256 hash computation for version hashes (ADR 02). Part of standard PostgreSQL distributions.
- **pgvector** — vector(128) topology embeddings for pattern discovery (ADR 25). Provided by the `pgvector/pgvector` Docker image or by installing the extension manually.

The Docker image `pgvector/pgvector:pg16` (used in `docker-compose.yml`) bundles both extensions. For a self-managed PostgreSQL installation, install pgvector separately: <!-- VERIFY: pgvector installation method for self-managed PostgreSQL host -->

### iii Engine

The iii worker bus must be installed and available on the system `PATH`:

```bash
# Verify iii is installed
iii --version
```

<!-- VERIFY: iii Engine installation method and download location -->

### Node.js Dependencies

Install all workspace dependencies from the project root:

```bash
npm install
```

---

## Build

Compile TypeScript to `dist/` before running in production:

```bash
npm run build
```

This runs `tsc` using `tsconfig.json` with `outDir: dist`. The compiled output targets ES2022 with ESNext modules.

To verify the TypeScript compilation without emitting files:

```bash
npm run typecheck
```

---

## Database Setup

### 1. Start PostgreSQL

Using Docker Compose (development/staging):

```bash
npm run db:up
# or directly:
docker compose up -d
```

For a production PostgreSQL instance, ensure the server is running and the target database exists.

### 2. Run Migrations

Set `DATABASE_URL` and run migrations:

```bash
export DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>
npm run db:migrate
# or directly:
npx tsx scripts/migrate.ts
```

`scripts/migrate.ts` reads SQL files from `migrations/` in alphabetical order, waits up to 30 seconds for the database to be ready, and runs each file idempotently. It reads `DATABASE_URL` from the environment (CI-injected) or from a `.env` file.

**Current migrations (run in this order):**

| File | Purpose |
|---|---|
| `001-extensions.sql` | Installs `pgcrypto` and `vector` extensions |
| `002-event-log.sql` | Execution event log schema |
| `003-memory-tables.sql` | Memory layer tables |
| `004-bus-state.sql` | Worker bus state tables |
| `005-scope-lineage.sql` | Scope lineage and partitioning |
| `006-memory-extensions.sql` | Extended memory columns |
| `007-pattern-discovery-mcp.sql` | Pattern discovery tables |
| `008-semantic-memory-validity.sql` | Semantic memory validity flags |
| `009-scope-lineage-view.sql` | Scope lineage view |
| `010-sub-scope-resolved.sql` | Sub-scope resolution tracking |
| `011-lesson-fingerprint.sql` | Lesson content fingerprinting |

Migration 001 uses `CREATE EXTENSION IF NOT EXISTS`, so re-running migrations is safe.

---

## Environment Variables

Copy `.env.example` to `.env` and set production values:

```bash
cp .env.example .env
```

For a full reference of all environment variables, see [docs/guides/configuration.md](configuration.md).

**Minimum required variables for production:**

| Variable | Production Value |
|---|---|
| `DATABASE_URL` | Connection string to production PostgreSQL (must have pgvector + pgcrypto) |
| `III_URL` | WebSocket URL of the iii Engine, e.g. `ws://localhost:4001` |
| `PORT` | Gateway HTTP port, e.g. `4000` |
| `LOG_LEVEL` | `info` or `warn` (avoid `debug` in production) |
| `LLM_BASE_URL` | Cloud LLM provider base URL |
| `LLM_MODEL` | Production model identifier |
| `LLM_API_KEY` | Real API key for the LLM provider |

**Recommended production-only settings:**

| Variable | Recommendation |
|---|---|
| `GRAPH_RUNTIME_SECRET` | Set to a strong random string to protect `POST /pair/generate` |
| `REQUIRE_AGENT_PAIRING` | Set to `true` to restrict MCP access to paired agents |
| `EXECUTE_BASH_ENABLED` | Leave unset (defaults to `false`) unless host shell access is required |
| `NOTIFY_WEBHOOK_URL` | Set to a Discord or Slack incoming webhook for Crystal/Lesson events |

<!-- VERIFY: production secret management approach (e.g., platform secret store, vault) -->

---

## Starting Services

Services must be started in the following order. **The iii Engine must be running before Workers register their functions. Workers must be registered before the Control Plane starts the Pulse-Fetch bridge.**

### Startup Order

```
iii Engine  →  (2s wait)  →  Workers  →  (3s wait)  →  Control Plane + Gateway
```

Reversing this order causes `function_not_found` errors because the Control Plane's Pulse-Fetch bridge replays queued DB events immediately on connect, before worker handlers are ready.

### Step 1 — Start the iii Engine

```bash
iii -c iii-config.yaml
```

The `iii-config.yaml` at the project root configures:
- `iii-worker-manager` on port `4001` (must match the port in `III_URL`)
- `iii-cron` — cron scheduling
- `iii-observability` — logging with `sampling_ratio: 0.1`
- `iii-queue` with `builtin` adapter — required for `durable:subscriber` topic routing
- `iii-pubsub` with `local` adapter — required for `durable:subscriber` delivery
- `iii-state` with `file_based` KV store at `.iii-state` — persistent trigger registration

Wait for the iii Engine to accept WebSocket connections before proceeding.

### Step 2 — Start Workers

```bash
node --import tsx/esm packages/workers/src/index.ts
```

Workers register all iii functions at boot, including the LLM-backed memory workers, pattern discovery, crystallization, lesson saving, and MCP client integration. The boot process also performs idempotent inserts for all internal Worker AgentCards into `agent_registry`.

Wait approximately 3 seconds for worker function registration to complete before starting the Control Plane.

### Step 3 — Start the Control Plane

```bash
node --import tsx/esm packages/control-plane/src/index.ts
```

The Control Plane:
- Registers as an iii worker (`control-plane`)
- Starts the Pulse-Fetch bridge (PostgreSQL `LISTEN`/`NOTIFY` → iii triggers)
- Instantiates the Convergence Watchdog

The Control Plane holds the DDL-exclusive pool for schema operations (ADR 05, ADR 24).

### Step 4 — Start the Gateway

```bash
bun run packages/gateway/src/index.ts
```

The Gateway (Hono on Bun) starts the HTTP server on the port defined by `PORT` (code-level fallback: `3000`). It holds a SELECT/INSERT-only PostgreSQL pool — no DDL rights (ADR 24).

### Optional — Start the Gateway Bot

The gateway-bot package is optional and not part of the core runtime:

```bash
node --import tsx/esm packages/gateway-bot/src/index.ts
```

Configure Telegram or Discord credentials in `.env` before starting. See [docs/guides/configuration.md](configuration.md) for the full variable reference.

---

## Health Checks

The Gateway exposes a single health endpoint:

```
GET /v1/sys/health
```

**Healthy response (HTTP 200):**

```json
{
  "engine_status": "ok",
  "live_scopes": 3,
  "suspended_count": 1,
  "slots": 10,
  "idle_slots": 8
}
```

**Degraded response (HTTP 503):**

```json
{
  "engine_status": "degraded"
}
```

A `503` response means the Gateway cannot reach the PostgreSQL database. Check `DATABASE_URL` and database connectivity.

**Docker Compose health check** (for the PostgreSQL service):

```
pg_isready -U postgres -d graph_test
```

Configured with `interval: 2s`, `timeout: 5s`, `retries: 20` in `docker-compose.yml`.

---

## Process Management

The development launcher (`npm run dev` / `node scripts/dev.mjs`) is not suitable for production — it manages all processes in a single parent process and exits if any child exits.

For production, manage each service as a separate supervised process.

### Using pm2

<!-- VERIFY: pm2 not observed as a project dependency — confirm acceptable for production use -->

```bash
# Install pm2 globally
npm install -g pm2

# Start services in order
pm2 start "iii -c iii-config.yaml" --name iii-engine
sleep 2

pm2 start "node --import tsx/esm packages/workers/src/index.ts" \
  --name workers --interpreter none
sleep 3

pm2 start "node --import tsx/esm packages/control-plane/src/index.ts" \
  --name control-plane --interpreter none

pm2 start "bun run packages/gateway/src/index.ts" \
  --name gateway --interpreter none

# Save process list for restart on reboot
pm2 save
pm2 startup
```

### Using systemd

<!-- VERIFY: systemd unit file paths and user account conventions for this deployment environment -->

Create one unit file per service. Example for the Workers service (`/etc/systemd/system/graph-workers.service`):

```ini
[Unit]
Description=Graph Runtime — Workers
After=network.target graph-iii.service
Requires=graph-iii.service

[Service]
Type=simple
User=<service-user>
WorkingDirectory=/path/to/graph-enginerring
EnvironmentFile=/path/to/graph-enginerring/.env
ExecStart=node --import tsx/esm packages/workers/src/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Define corresponding unit files for `graph-iii.service`, `graph-control-plane.service`, and `graph-gateway.service`, with `After=` and `Requires=` dependencies enforcing the startup order.

---

## Upgrade Procedure

1. **Pull the latest code:**
   ```bash
   git pull origin master
   ```

2. **Install updated dependencies:**
   ```bash
   npm install
   ```

3. **Stop all services** (in reverse startup order — gateway first, iii engine last):
   ```bash
   # pm2
   pm2 stop gateway control-plane workers iii-engine
   # or systemd
   systemctl stop graph-gateway graph-control-plane graph-workers graph-iii
   ```

4. **Run any new migrations:**
   ```bash
   npm run db:migrate
   ```
   Migrations are idempotent (`CREATE EXTENSION IF NOT EXISTS`, `ON CONFLICT DO NOTHING` patterns). Running previously-applied migrations is safe.

5. **Rebuild compiled output:**
   ```bash
   npm run build
   ```

6. **Restart services in startup order:**
   ```bash
   # pm2
   pm2 restart iii-engine
   sleep 2
   pm2 restart workers
   sleep 3
   pm2 restart control-plane gateway
   # or systemd
   systemctl start graph-iii
   sleep 2
   systemctl start graph-workers
   sleep 3
   systemctl start graph-control-plane graph-gateway
   ```

7. **Verify health:**
   ```bash
   curl http://localhost:4000/v1/sys/health
   ```
   Confirm `engine_status: "ok"` before declaring the upgrade complete.

**Rollback:** <!-- VERIFY: no rollback automation observed in repository — confirm rollback procedure for this deployment -->
If the health check returns `degraded` after upgrade, redeploy the previous commit and re-run migrations from that revision. Database migrations in this project are additive (no destructive `DROP` statements observed) and do not need to be reversed for a rollback.
