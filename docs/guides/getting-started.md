<!-- generated-by: gsd-doc-writer -->
# Getting Started

This guide walks you from a clean checkout to a fully running Memex instance with all four services online. Follow each step in order.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 18 | Required for Workers and Control Plane (`node --import tsx/esm`) |
| Bun | Latest stable | Required for the Gateway (`bun run`) |
| Docker | >= 20 | Required for the PostgreSQL service via Docker Compose |
| `iii` CLI | 0.17.x | Worker bus engine; install via the iii SDK docs |
| npm | >= 9 | Used for workspace dependency installation |

> **Bun install:** `curl -fsSL https://bun.sh/install | bash` (macOS/Linux) or see [bun.sh](https://bun.sh) for Windows.
> The dev launcher automatically adds `~/.bun/bin` to `PATH` on Windows.

---

## 1. Clone and Install

```bash
git clone <repository-url>
cd graph-enginerring
npm install
```

`npm install` resolves all workspace packages (`packages/*`) in a single pass.

---

## 2. Environment Setup

Copy the example file and review the values:

```bash
cp .env.example .env
```

The defaults in `.env.example` work as-is for local development with Docker Compose. The two variables that must be correct are:

| Variable | Default | Why it matters |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:password@localhost:5432/graph_test` | Points to the Docker Compose PostgreSQL instance |
| `III_URL` | `ws://localhost:4001` | Must match the `iii-worker-manager` port in `iii-config.yaml` |

LLM variables (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) default to a local Ollama instance. For cloud providers or if you do not need crystallization locally, placeholder values are sufficient to boot — CrystallizeWorker will fail gracefully without blocking other workers.

See [configuration.md](./configuration.md) for the full variable reference.

---

## 3. Start the Database

```bash
npm run db:up
```

This runs `docker compose up -d` and starts the `pgvector/pgvector:pg16` container. Both `pgvector` (semantic search) and `pgcrypto` (SHA-256 hash chains) are included in this image.

Wait for the container healthcheck to pass before proceeding. The healthcheck retries every 2 seconds up to 20 times:

```bash
docker compose ps   # postgres should show "healthy"
```

---

## 4. Run Migrations

```bash
npm run db:migrate
```

This runs `scripts/migrate.ts` via `tsx`, which applies all schema migrations to `graph_test`. The schema creates the tables required by the Trail Mesh: `entities`, `versions`, `hyper_edges`, `episodic_memory`, `lessons`, `crystals`, `scope_lineage`, `execution_event_log`, `agent_registry`, and others.

If the database is in an unknown state, reset it cleanly with:

```bash
npm run db:reset   # destructive: drops volumes, recreates, and re-migrates
```

---

## 5. Start All Services

The recommended way to run everything locally is the dev launcher:

```bash
npm run dev
```

This starts all four services in the correct order with a 2-second gap between each stage:

1. **iii Engine** (`iii -c iii-config.yaml`) — worker bus on port `4001`
2. **Workers** (`node --import tsx/esm packages/workers/src/index.ts`) — all worker registrations
3. **Control Plane** (`node --import tsx/esm packages/control-plane/src/index.ts`) — Pulse-Fetch bridge + Convergence Watchdog
4. **Gateway** (`bun run packages/gateway/src/index.ts`) — HTTP API on port `4000`

> **Order is mandatory.** Workers must register their functions with iii before the Control Plane starts. The Control Plane's Pulse-Fetch bridge replays pending DB events immediately on connect — if workers are not yet registered when that replay fires, those events are lost.

The launcher reads `.env` automatically and injects values into all child processes. You do not need to `source` or `export` manually.

To stop all services: `Ctrl+C`.

### Starting Services Individually

If you need to run services in separate terminals:

```bash
# Terminal 1 — iii Engine (start first)
iii -c iii-config.yaml

# Terminal 2 — Workers (start after iii is ready)
node --import tsx/esm packages/workers/src/index.ts

# Terminal 3 — Control Plane (start after workers are registered)
node --import tsx/esm packages/control-plane/src/index.ts

# Terminal 4 — Gateway (start after control plane is ready)
bun run packages/gateway/src/index.ts
```

When starting manually, wait ~2 seconds between each stage. The `.env` file must be loaded in each terminal (`export $(grep -v '^#' .env | xargs)` on Linux/macOS, or set variables directly on Windows).

---

## 6. Verify Installation

Once all services are running, check the Gateway health endpoint:

```bash
curl http://localhost:4000/v1/sys/health
```

Expected response:

```json
{
  "engine_status": "ok",
  "live_scopes": 0,
  "suspended_count": 0,
  "slots": 10,
  "idle_slots": 10
}
```

`engine_status: "ok"` confirms the Gateway can reach PostgreSQL. If you see `"degraded"`, the database is not reachable — check `docker compose ps` and verify `DATABASE_URL` in `.env`.

---

## 7. First API Calls

### Create a Scope

A Scope is a bounded workspace for a Trail. Every agent session starts by creating one.

```bash
curl -s -X POST http://localhost:4000/v1/scopes \
  -H "Content-Type: application/json" \
  -d '{"intent": "Investigate the root cause of login failures in production"}'
```

Response:

```json
{
  "scope_id": "550e8400-e29b-41d4-a716-446655440000",
  "plan_hash": "a3f5c1...",
  "context": { "tokens_used": 0, "items": [] }
}
```

Save the `scope_id` — you will need it for all subsequent event writes.

### Post an Event

Events are the atomic units of the Trail. Each write uses Optimistic Concurrency Control (OCC).

```bash
SCOPE_ID="550e8400-e29b-41d4-a716-446655440000"

curl -s -X POST http://localhost:4000/v1/scopes/${SCOPE_ID}/events \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "ent-00000000-0000-0000-0000-000000000001",
    "event_type": "task_spawned",
    "predecessor_hash": "0000000000000000000000000000000000000000000000000000000000000000",
    "payload": {
      "description": "Check application logs for error patterns"
    }
  }'
```

Response:

```json
{
  "version_hash": "b7e2f4...",
  "occ_result": "written",
  "context": { "tokens_used": 142, "items": [...] }
}
```

Use the returned `version_hash` as the `predecessor_hash` for the next event in this entity's chain.

### Read Scope State

```bash
curl -s http://localhost:4000/v1/scopes/${SCOPE_ID}
```

---

## Common Setup Issues

**Port already in use (`EADDRINUSE 4000` or `4001`):**
The dev launcher automatically frees occupied ports on startup. If running services manually, identify the occupying process and terminate it before starting.

**`Cannot find module 'tsx/esm'`:**
Run `npm install` from the project root to ensure workspace dependencies are installed. The `tsx` package is a root devDependency.

**`iii: command not found`:**
Install the `iii` CLI. Refer to the iii Engine documentation for the install command. The `iii-sdk` npm package is the client library, not the server binary.

**Workers connect but then show `function_not_found` errors:**
The Control Plane started before Workers finished registering. Stop all services and restart with `npm run dev`, which enforces the 2-second + 3-second startup gaps automatically.

**Database migration fails with `extension "pgvector" does not exist`:**
Ensure you are using the Docker Compose database (`docker compose up -d`), not a local PostgreSQL installation. The `pgvector/pgvector:pg16` image includes the extension. A bare PostgreSQL install requires `CREATE EXTENSION pgvector` and `CREATE EXTENSION pgcrypto` manually.

---

## Next Steps

- [configuration.md](./configuration.md) — Full environment variable reference, LLM provider setup, and per-package notes.
- [docs/ARCHITECTURE.md](../ARCHITECTURE.md) — System overview, component diagram, and data flow through the Trail Mesh.
