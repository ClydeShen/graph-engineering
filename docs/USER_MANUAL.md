<!-- generated-by: claude-code -->
# MemexOS User Manual

> Baseline: 1.0 candidate (Phases 1–16 complete, 479 tests passing, `tsc` clean).
> This manual is for **end users / operators**, covering installation,
> configuration, and usage of every implemented feature.
> Developer-facing docs live in `docs/guides/`; full API details in
> `docs/api/reference.md`; a five-minute overview is in `docs/QUICKSTART.md`.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Core Concepts](#2-core-concepts)
3. [System Requirements](#3-system-requirements)
4. [Installation](#4-installation)
5. [Initial Setup & Configuration](#5-initial-setup--configuration)
6. [Connecting AI Agents (Claude Code / Pi Terminal)](#6-connecting-ai-agents-claude-code--pi-terminal)
7. [Core Feature: The Trail Mesh](#7-core-feature-the-trail-mesh)
8. [Memory System & Trail Discovery (Getting Smarter With Use)](#8-memory-system--trail-discovery-getting-smarter-with-use)
9. [MemexTerminal (Built-in TUI)](#9-memexterminal-built-in-tui)
10. [Dashboard (Live View)](#10-dashboard-live-view)
11. [Messaging Connectors & Scheduled Tasks](#11-messaging-connectors--scheduled-tasks)
12. [Multi-Agent Collaboration (Federation)](#12-multi-agent-collaboration-federation)
13. [Skill Ecosystem](#13-skill-ecosystem)
14. [Security & Trust Model](#14-security--trust-model)
15. [Operations: Diagnostics / Backup / Service / Multi-Environment](#15-operations-diagnostics--backup--service--multi-environment)
16. [Troubleshooting](#16-troubleshooting)
17. [Reference](#17-reference)

---

## 1. Introduction

MemexOS is a **graph-native agent runtime**: every step of an agent's
execution is written as an immutable event into a PostgreSQL "graph ledger"
(the Trail Mesh). On every call, the context window the agent receives is a
*projection* of that graph along the causal chain — not a hand-maintained
chat history.

There is no "workflow engine". Recurring execution structures (Trail
Discovery) are automatically recognized, distilled into Lessons, and
proactively injected as "skeleton templates" into future similar tasks — the
system **gets smarter the more it is used**.

**MemexOS three-layer architecture:**

| Layer | Name | Contents |
|---|---|---|
| Product brand | **MemexOS** | The combination of MemexCore + MemexShell |
| Core runtime | **MemexCore** | iii Engine, PostgreSQL ledger, Workers, Control Plane, Gateway (REST + MCP + WS/SSE) |
| Interaction/integration | **MemexShell** | MemexTerminal (built-in TUI), Dashboard (live view), `memex` CLI, messaging connectors (Telegram/Discord/Slack/Email/Webhook), scheduled tasks |

The Shell holds no state of its own — all state lives in the Core's graph;
the Shell is purely a client of the Gateway REST/WS API.

---

## 2. Core Concepts

| Term | Description |
|---|---|
| **Trail** | The full execution record within a Scope, including deviations, conflicts, and retries — not just the "success path" |
| **Association** | A directed, immutable hyper-edge `(source, target, event_type, version_hash, timestamp)` |
| **Entity** | A logical object with a stable UUID, addressable across every Trail that touched it |
| **Snapshot** | The immutable state of an Entity at a point in time, content-addressed by SHA-256 |
| **Trail Mesh** | The aggregate of all Trails and Associations — the single source of truth (SSOT) |
| **Scope** | A bounded workspace in which a Trail is recorded — typically one agent session or one sub-task |
| **Crystallization** | The process by which an LLM distills a closed Trail into a Lesson |
| **Lesson** | An extracted insight; confidence-weighted, reinforced on an Ebbinghaus forgetting-curve schedule |
| **Trail Discovery** | Statistical extraction of reusable patterns from historical Trails, written into procedural memory |
| **OCC** | Optimistic Concurrency Control — every write uses `predecessor_hash` for optimistic concurrency |

---

## 3. System Requirements

| Dependency | Version | Notes |
|---|---|---|
| Node.js | **22+** | Workers / Control Plane / CLI / Gateway all run on Node 22 |
| PostgreSQL | **16+**, with `pgvector` + `pgcrypto` extensions | The `pgvector/pgvector:pg16` image is recommended |
| git | Any recent version | The one-line installer clones the source via git |
| Docker (optional) | Any recent version | Used to start the database if none is local, or for a fully containerized deployment |
| iii Engine | Installed via the `iii-sdk` dependency | The worker bus |

**Supported platforms:** Linux, macOS, Windows 10/11 (native PowerShell or WSL2).

---

## 4. Installation

MemexOS supports three installation methods — pick whichever fits your setup.

### 4.1 Method 1: One-line installer (recommended for bare metal / personal servers)

**Linux / macOS / WSL2:**

```sh
curl -fsSL https://raw.githubusercontent.com/ClydeShen/graph-enginerring/master/scripts/install.sh | sh
```

**Windows (native PowerShell):**

```powershell
iex (irm https://raw.githubusercontent.com/ClydeShen/graph-enginerring/master/scripts/install.ps1)
```

The installer (idempotent, safe to re-run) does the following:

1. Checks for `git` and `Node 22+`; if missing, it errors out with install links
   instead of silently installing system-level dependencies for you.
2. Checks for a usable local PostgreSQL:
   - found → reuses it (you must confirm `pgvector` + `pgcrypto` are installed);
   - not found but Docker available → starts `pgvector/pgvector:pg16` via the
     bundled `docker compose`;
   - neither → prompts you to install Docker or PostgreSQL and re-run.
3. Clones the repository into `~/.memex/app` (override with `MEMEX_INSTALL_DIR`).
4. Installs dependencies with `npm ci`.
5. Runs database migrations (`scripts/migrate.ts`).
6. Writes an `~/.memex/install.json` install marker (records install method,
   version, timestamp).
7. In an interactive terminal, drops straight into the `memex onboard` wizard;
   when piped non-interactively, prints the follow-up commands instead.

After installation you can run diagnostics at any time:

```sh
cd ~/.memex/app
npx tsx packages/cli/src/index.ts doctor
```

> Customize via environment variables: `MEMEX_REPO_URL` (your own fork) and
> `MEMEX_INSTALL_DIR` (install location).

### 4.2 Method 2: Docker one-shot deployment (recommended for servers / exposed setups)

The repository ships a complete compose file: Postgres(pgvector) + migration +
iii Engine + Workers + Control Plane + Gateway, with persistent volumes:

```sh
git clone https://github.com/ClydeShen/graph-enginerring.git
cd graph-enginerring
docker compose -f deploy/docker-compose.yml up -d
```

By default the Gateway listens on `0.0.0.0:3000` inside the container; the
host port can be changed with `MEMEX_GATEWAY_PORT` (default `3000`):

```sh
MEMEX_GATEWAY_PORT=8080 docker compose -f deploy/docker-compose.yml up -d
```

Volumes:

- `pgdata` — PostgreSQL data directory
- `memex-home` — the container's `~/.memex` (config.json, profiles, backups, etc.)

**Hardened deployment (strongly recommended for anything reachable from
outside your machine):**

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.hardened.yml up -d
```

The hardened override adds: `internal`/`egress` dual-network isolation, an
outbound proxy allowlist, and container security options such as
`cap-drop` and `no-new-privileges` — a direct product of the Phase 14
trust-isolation work. See [SECURITY.md](../SECURITY.md) for the full model.

Once running, you can run diagnostics inside the container too:

```sh
docker compose -f deploy/docker-compose.yml exec gateway \
  node packages/cli/dist/index.js doctor
```

### 4.3 Method 3: Source / development environment (for contributors)

```sh
git clone https://github.com/ClydeShen/graph-enginerring.git
cd graph-enginerring
cp .env.example .env          # edit as needed
npm install
npm run db:up                  # docker compose up -d (Postgres only)
npm run db:migrate
npm run dev                     # starts iii → workers → control-plane + gateway in order
```

`npm run dev` (`scripts/dev.mjs`) starts all services in this order, with
aggregated colorized logs: iii Engine → (after 2s) Workers → (after 3s)
Control Plane + Gateway.

For starting services individually, running unit/integration tests, and the
workflow for adding new Workers/routes, see `docs/guides/development.md` and
`docs/guides/getting-started.md`.

---

## 5. Initial Setup & Configuration

MemexOS configuration has two layers with non-overlapping responsibilities:

| Config file | Scope | Use case |
|---|---|---|
| `~/.memex/config.json` (or `~/.memex/profiles/<name>/config.json`) | System-wide: Gateway port/token, LLM provider registry, channel tokens, Shell connection addresses, per-profile database connection | **Production / daily use** — generated by `memex onboard` |
| `iii-config.yaml` (repo root) | iii Engine only (worker bus port, queue/pubsub adapters, observability sampling rate) | **Development / source deployments**, rarely needs to change |
| `.env` (repo root, source mode) | `DATABASE_URL`, `III_URL`, per-Worker LLM credentials, etc. | **Source development mode only**; not needed for one-line installer / Docker users |

### 5.1 First-time setup: `memex onboard`

```sh
npx tsx packages/cli/src/index.ts onboard
# or, once installed: memex onboard
```

The interactive wizard asks, in order:

1. **LLM provider** — one of five:
   - `Anthropic (Claude)`: defaults to model `claude-sonnet-4-6`; the API key
     is stored as an `${ANTHROPIC_API_KEY}` environment-variable reference
     (the raw key is never written to disk).
   - `Ollama (local)`: defaults to `http://localhost:11434`, model `llama3`.
   - `vLLM (local)`: defaults to `http://localhost:8000`.
   - `LM Studio (local)`: defaults to `http://localhost:1234`.
   - `DeepSeek`: defaults to `https://api.deepseek.com`, key referenced as
     `${DEEPSEEK_API_KEY}`.
   For a **local** provider (Ollama, llama.cpp, LM Studio, vLLM, oMLX) the wizard
   then asks you to confirm its **endpoint URL** with the default pre-filled —
   edit it if your server runs on a non-default port. On Windows, if a model list
   can't be fetched from `http://localhost:<port>`, change `localhost` to
   `127.0.0.1`: `localhost` resolves to IPv6 `::1` first, which a server bound
   only to `127.0.0.1` refuses.
2. **API key** — pasted directly (not a variable name); it is written to `.env`
   (gitignored) and the config keeps only a `${ENV_VAR}` reference. Local
   providers that need no key skip this step.
3. **Model** — picked from a live list fetched from the provider with the key
   from step 2 (the provider's recommended default is pinned to the top). If the
   list can't be fetched (offline, no key, or an endpoint without a `/models`
   route) the wizard falls back to typing a model name, default pre-filled.
4. **Gateway port** (default `3000`).
5. **Whether to generate a realtime API token** — if the Gateway will be
   reachable over a LAN or the internet, choose "yes"; a random 24-byte hex
   token is generated and written to the config (used to authenticate WS/SSE
   and remote connections).

Example resulting `~/.memex/config.json`:

```json
{
  "gateway": {
    "port": 3000,
    "websocket": true,
    "token": "<randomly generated token>"
  },
  "providers": [
    {
      "name": "anthropic",
      "type": "anthropic",
      "model": "claude-sonnet-4-6",
      "priority": 1,
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  ]
}
```

Re-running `memex onboard` first backs up the existing config to
`config.json.bak`, then asks whether to overwrite it.

### 5.2 Full `~/.memex/config.json` field reference

| Field | Description |
|---|---|
| `gateway.port` | Gateway listen port |
| `gateway.websocket` | Whether the realtime WS/SSE API is enabled (default: on) |
| `gateway.token` | Auth token for WS/SSE and remote connections (`${ENV_VAR}` references apply here too) |
| `providers[]` | LLM provider registry; each entry has `name` / `type` (`anthropic` or `openai-compatible`) / `model` / `priority` / `baseUrl` / `apiKey` |
| `channels.<platform>` | Per-channel config: `token` (`${ENV_VAR}` reference) + `home_channel` (DeliveryRouter's default delivery target) |
| `webhook.hmac_secret` | HMAC secret for the inbound webhook channel (required for that channel to start) |
| `shell.gateway_url` | The Gateway address that MemexTerminal / Dashboard / CLI connect to (for a remote Core) |
| `database.url` | The database connection string for this profile (multi-environment isolation) |

Any `${VAR_NAME}` reference is substituted with the corresponding environment
variable's value at load time — **the resolved value is never written back to
disk**; secrets only ever live in environment variables.

### 5.3 LLM Providers in Detail

- **Anthropic**: set the `ANTHROPIC_API_KEY` environment variable and
  `LLM_API=anthropic-messages` (in `.env` for source mode; in config.json mode
  `onboard` already sets `type: anthropic` for you).
- **Local models (Ollama / vLLM / LM Studio)**: no API key needed —
  `baseUrl` just points at the local port. Good for offline/privacy-first
  setups.
- **DeepSeek and other OpenAI-compatible services**: `type: openai-compatible`,
  with `baseUrl` + an `apiKey` reference.
- **Embeddings (used by semantic memory)**: always use the
  `openai-completions` protocol (Anthropic has no embeddings endpoint). In
  source mode, set `EMBEDDING_MODEL` separately; if unset it falls back to
  `LLM_MODEL`.

### 5.4 `.env` (source development mode only)

Copy `.env.example` to `.env`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:password@localhost:5432/graph_test` | PostgreSQL connection string; must have pgvector |
| `III_URL` | `ws://localhost:4001` | iii Engine WebSocket address |
| `PORT` | `4000` | Gateway HTTP port |
| `LOG_LEVEL` | `info` | pino log level; use `debug` for troubleshooting |
| `LLM_API` | `openai-completions` | `openai-completions` or `anthropic-messages` |
| `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` | — | The LLM provider triplet |
| `CONTEXT_W_MAX` | `4096` | Knapsack context token budget |
| `GRAPH_RUNTIME_SECRET` | — | If set, `/pair/generate` requires a Bearer token |
| `REQUIRE_AGENT_PAIRING` | `false` | If `true`, all MCP requests require a paired `X-Agent-ID` |
| `EXECUTE_BASH_ENABLED` | `false` | Whether the `execute_bash` MCP tool is enabled |
| `MCP_SERVER_URLS` | — | Comma-separated list of external MCP server URLs to register as tools |
| `NOTIFY_WEBHOOK_URL` | — | Discord/Slack-style webhook for Crystal/Lesson event notifications |

The full variable table (including per-channel bot tokens) is in
`docs/guides/configuration.md`.

### 5.5 Multi-Environment Profiles

```sh
MEMEX_PROFILE=staging memex doctor
MEMEX_PROFILE=staging npx tsx packages/cli/src/index.ts onboard
```

Setting `MEMEX_PROFILE=<name>` makes every `memex` command use
`~/.memex/profiles/<name>/config.json`, and that profile's `database.url` can
point at an entirely separate database instance — giving you full
configuration + data isolation (useful for dev/staging/production coexisting,
or for multiple machines sharing one Trail Mesh).

### 5.6 `iii-config.yaml` (engine layer, rarely needs changes)

In source deployments, `iii-config.yaml` at the repo root configures the iii
Engine:

```yaml
workers:
  - name: iii-worker-manager
    config:
      port: 4001          # must match the port in III_URL
  - name: iii-observability
    config:
      sampling_ratio: 0.1  # do NOT set to 1.0 — caused a 137GB log loop once
  - name: iii-queue
    config: { adapter: { name: builtin } }
  - name: iii-pubsub
    config: { adapter: { name: local } }
  - name: iii-state
    config: { adapter: { name: kv, config: { store_method: file_based, file_path: .iii-state } } }
```

The `iii-queue`/`iii-pubsub` adapters are required for the Workers package's
`durable:subscriber` routing to work correctly — don't change them casually.

---

## 6. Connecting AI Agents (Claude Code / Pi Terminal)

```sh
memex connect
# or in source mode: npx tsx packages/cli/src/index.ts connect
```

An interactive multi-select supports:

- **Claude Code (MCP)**: writes a `graph-runtime` entry into
  `~/.claude.json`'s `mcpServers` (`type: "http"`, `url` pointing at
  `<Gateway>/mcp`). If `GRAPH_RUNTIME_SECRET` is set, an
  `Authorization: Bearer` header is attached automatically. If already
  configured it reports "already wired"; pass `--force` to rewrite it (the
  original file is backed up automatically).
- **Pi Terminal (extension)**: installs the extension into
  `~/.pi/agent/extensions/`.

To connect to a remote Gateway, set the `GRAPH_RUNTIME_URL` environment
variable, or configure `shell.gateway_url` in the active profile —
`memex connect` prefers that value (TLS is the responsibility of your reverse
proxy).

### 6.1 Agent Pairing (optional authentication)

When `REQUIRE_AGENT_PAIRING=true`, every MCP endpoint (`/mcp`, `/mcp/sse`,
`/mcp/messages`) requires an `X-Agent-ID` header, and that ID must first
complete pairing:

```sh
# 1. Admin generates a one-time pairing code (requires GRAPH_RUNTIME_SECRET)
curl -X POST http://localhost:4000/pair/generate \
  -H "Authorization: Bearer $GRAPH_RUNTIME_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent-01"}'
# => { "code": "X7KQ2MFA", "expires_in_s": 3600 }

# 2. The agent completes pairing using the code
curl -X POST http://localhost:4000/pair \
  -H "Content-Type: application/json" \
  -d '{"agent_id": "my-agent-01", "code": "X7KQ2MFA"}'
# => { "paired": true }
```

Pairing codes are valid for one hour; five failed verification attempts lock
that `agent_id`. `/v1/*` and `/health` are not subject to this gate.

---

## 7. Core Feature: The Trail Mesh

Every agent interaction ultimately reduces to two actions: **create a Scope**
and **write events**.

### 7.1 REST API

**Create a Trail (Scope):**

```sh
curl -X POST http://localhost:4000/v1/scopes \
  -H "Content-Type: application/json" \
  -d '{"intent": "Investigate a performance regression in the checkout flow"}'
```

The response includes `scope_id` (the stable ID for this Trail) and
`plan_hash` (the predecessor hash for the first event write).

**Write an event** (`event_type` may only be `task_spawned` or
`memory_updated`; `plan_created`/`scope_closed` are written internally by the
Gateway and cannot be written directly by agents):

```sh
curl -X POST http://localhost:4000/v1/scopes/<scope_id>/events \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "11111111-1111-4111-8111-111111111111",
    "event_type": "memory_updated",
    "payload": {"note": "A database index reduced query time by 80%"},
    "predecessor_hash": "<hash returned previously>"
  }'
```

The response's `version_hash` is the new chain-head hash, to be used as the
`predecessor_hash` for the next write; `context: null` means the Scope has
converged and closed, and the agent should terminate.

**Other commonly used read-only endpoints:**

| Endpoint | Purpose |
|---|---|
| `GET /v1/scopes/:id` | Query Scope status (`active`/`closed`/`suspended`) and current context |
| `GET /v1/scopes/:id/topology` | Returns the Trail's node/edge graph (up to 500 nodes, for visualization) |
| `GET /v1/sys/health` | Runtime health check: active scope count, connection pool status |
| `GET /.well-known/agent-card.json` | This system's own AgentCard (for discovery by external orchestrators) |

See `docs/api/reference.md` for full field definitions and error codes.

### 7.2 MCP Tools

Once connected via Claude Code / Pi Terminal, agents can call the following
MCP tools directly (`/mcp`, JSON-RPC 2.0 `tools/call`):

| Tool | Purpose |
|---|---|
| `spawn_subtask` | Spawn a sub-task by `required_skills` (**explicit agent assignment is forbidden** — routing is skill-only) |
| `claim_next_task` | Atomically claim the next pending sub-task matching a skill set (`FOR UPDATE SKIP LOCKED`) |
| `get_task_status` | Query the current status of a task |
| `complete_task` | Mark a task done and write its result |
| `wait_all_tasks` | Wait for a batch of tasks to complete (1–600s timeout) |
| `register_agent` | Register an external agent's AgentCard |
| `query_context` | Read a recent causal-chain summary for a Scope |
| `execute_bash` | Run a shell command on the host (requires `EXECUTE_BASH_ENABLED=true`, see section 14) |

---

## 8. Memory System & Trail Discovery (Getting Smarter With Use)

MemexOS implements four layers of memory:

| Layer | Written when | Retrieved by |
|---|---|---|
| **Working Memory** | On every event write | The `execution_event_log`, the source for Knapsack context assembly |
| **Episodic Memory** | When a Scope closes (`scope_closed`) | Intent + result summaries, vector + temporal indexes |
| **Semantic Memory** | When knowledge is distilled/updated | Vector index + a `superseded_by` self-referential version chain (old versions aren't deleted, just excluded from retrieval) |
| **Procedural Memory** | When Trail Discovery extracts a skeleton | Dual HNSW partitions for positive (successful skeletons) and negative (anti-pattern) samples |

### 8.1 Semantic Search & Reinforcement

```sh
# Hybrid search (BM25 + vector RRF) within a Scope
curl "http://localhost:4000/v1/memory/search?q=checkout+performance&scope_id=<scope_id>"

# Mark a procedural memory entry as "useful" — triggers Ebbinghaus reinforcement
curl -X POST http://localhost:4000/v1/memory/reinforce \
  -H "Content-Type: application/json" \
  -d '{"template_id": "<procedural-memory-id>"}'
```

### 8.2 How Trail Discovery Works

1. **TemplateProposalWorker**: triggered on every `scope_closed`, runs in its
   own context window:
   - Identifies low-conflict, fast-converging paths → extracts a "skeleton"
     (an abstract sequence of event types/associations) → writes it to
     `procedural_memory` as a positive sample.
   - Traces "error → fix" causal pairs → writes them as anti-pattern
     (negative) samples.
2. **Cold-start injection**: when a new Scope is created, a Top-20
   nearest-neighbor search on the intent embedding plus a three-signal rerank
   selects matching "golden skeletons" and "pitfalls to avoid", which are
   injected into the initial context.
3. **PatternDiscoveryWorker**: periodically scans the entire Trail Mesh for
   topologies that recur across different task types (e.g.
   "explore → hypothesize → validate → converge") and writes them into
   semantic memory for future reuse.

The three metrics that measure whether "the system is getting smarter" —
Trail Discovery hit rate, Lesson retention/reinforcement rate, and
post-Knapsack-compression task success rate — can be observed via the eval
script:

```sh
npx tsx scripts/eval/journey.ts
```

---

## 9. MemexTerminal (Built-in TUI)

MemexTerminal is the built-in default TUI — purely a Gateway client, holding
no state of its own.

```sh
npx tsx packages/terminal/src/index.ts
```

On startup it:

1. Reads `shell.gateway_url` (or falls back to
   `http://127.0.0.1:<gateway.port>`) and `gateway.token` from
   `~/.memex/config.json`; both can be overridden with the
   `MEMEX_GATEWAY_URL` / `MEMEX_GATEWAY_TOKEN` environment variables.
2. Creates a new Scope (`session:terminal:<timestamp>`).
3. Subscribes to that Scope's live Trail events over WS, printing each one as
   `⟶ [event_type] {...}`.

To use it: type at the `memex>` prompt and press Enter — this writes a
`task_spawned` event and prints a confirmation (`✓ recorded <hash> (won)`).
Duplicate content within a 5-minute window is flagged instead of being
re-recorded. Type `/quit` or `/exit` to leave.

> The current version is a read/write REPL over the graph. A Pi-SDK
> interactive mode that drives a local coding agent is the documented next
> increment, and requires a live Gateway plus provider keys to verify.

---

## 10. Dashboard (Live View)

The Gateway includes a zero-build read-only live view page:

```
http://localhost:4000/dashboard
```

If `gateway.token` is configured, append `?token=<token>` to the URL.

The page has two panes:

- **Left**: a live SSE feed (`/v1/stream`) of Trail events across the system,
  with each `event_type` (`scope_closed`, `conflict_detected`, `task_spawned`,
  `memory_updated`) shown with a different colored left border.
- **Right**: enter any `scope_id` and click "load" to view that Trail's
  topology (nodes = version hashes, edges = predecessor relationships).

This page is read-only by design — there is no write path (UI-SPEC
principle 2). A full graph-visualization Console (Next.js + G6) is planned for
a later Shell phase; the Dashboard is currently a zero-install window proving
out the realtime data path end to end.

---

## 11. Messaging Connectors & Scheduled Tasks

The Gateway-Bot (`packages/gateway-bot`) is an optional messaging interface.
It is **not** started by `npm run dev` — run it separately:

```sh
npx tsx packages/gateway-bot/src/index.ts
```

### 11.1 Per-Channel Configuration

| Channel | Required env vars | Notes |
|---|---|---|
| **Telegram** | `TELEGRAM_BOT_TOKEN` | Long-poll by default; setting `TELEGRAM_WEBHOOK_URL` switches to webhook mode (listens on port 4002) |
| **Discord** | `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY` | `DISCORD_PORT` (default 4001) is the interactions callback port; the public key verifies interaction signatures |
| **Slack** | `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN` | Implemented with zero extra SDK dependencies |
| **Email** | `MEMEX_IMAP_URL`, `MEMEX_SMTP_URL` (written to `~/.memex/config.json` under `channels.email`) | Replies are marked `pii_safe: true` |
| **Webhook (inbound)** | `MEMEX_WEBHOOK_HMAC_SECRET` | HMAC signature verification is **mandatory** — unsigned requests get a 401 and write nothing to the graph; content is tagged `untrusted` with a restricted toolset (see section 14) |

Every channel maps incoming messages to a stable `sender_id` (channel-prefixed,
e.g. `telegram:12345678`) via `dispatchMessage()`, and routes to the same
Scope — so the session's context accumulates in the graph and can continue
across channels.

Channel configuration changes are themselves graph data:
`registerConfigChange()` writes a `connector::config_updated`-tagged event, so
configuration history is queryable and can be analyzed by Trail Discovery.

### 11.2 DeliveryRouter (Delivery Rules)

A task's result is routed by its `deliver` field, using this syntax:

- `origin` — back to the channel/session that initiated the message
- `<platform>` — that platform's home channel (configured via
  `channels.<platform>.home_channel`)
- `<platform>:<chat_id>` — a specific session
- `all` — every configured channel
- a comma-separated combination of the above

Silent outputs (results carrying a "silence" marker) are not delivered.

### 11.3 Graph-Native Cron (Scheduled Tasks)

Scheduled tasks are **not** stored in a `jobs.json` file — each one is an
Entity (a Snapshot within the `cron:registry` Scope) with these fields:

```json
{
  "kind": "cron_job",
  "name": "weekly-report",
  "schedule": "0 9 * * 1",
  "prompt": "Summarize last week's graph activity and produce a report",
  "deliver": "telegram",
  "enabled": true
}
```

- `schedule` is a standard 5-field cron expression (minute hour day-of-month
  month day-of-week; supports `*`, `*/n`, `a,b,c`, `a-b` — no seconds, no
  named aliases).
- Writing a new Snapshot with the same `name` updates the job (the latest
  version wins); configuration history is preserved.
- Each firing opens a brand-new Scope (i.e., a new Trail); **missed ticks are
  never caught up**; duplicate firings within the same minute are prevented by
  a uniqueness check on the run Scope's intent.
- A scheduled task's run history is itself learnable by Trail Discovery —
  "this weekly report always deviates at the same step" is a signal in its
  own right.

---

## 12. Multi-Agent Collaboration (Federation)

MemexOS's answer to "multi-agent frameworks" is: **no orchestration layer —
collaboration patterns emerge from the shared Trail Mesh.** Agents don't talk
to each other directly; they collaborate through the same graph.

- **Internal delegation**: a Worker can spawn a sub-Scope agent, with results
  converging back into the parent Trail; the parent Scope can see the child
  Scope's deviations and conflicts, not just its final result.
- **External agent federation**: register an AgentCard via
  `POST /v1/agents/register` or the `register_agent` MCP tool (`name` /
  `skills` / `protocol` / `endpoint`). Multiple agents declaring the same
  skill then compete for routing based on trust level + historical success
  rate.
- **Graph-mediated collaboration**: multiple agents writing to the same Scope
  use OCC semantics; conflicting writes by two agents to the same Entity are
  first-class Trail data, surfaced into a high-priority context layer.
- **Cross-agent shared memory**: Lessons have visibility domains —
  `agent-private` / `shared` / `global`. When an external agent hits a shared
  Lesson, it also triggers Ebbinghaus reinforcement — the system gets smarter
  from every participant's usage.
- **Cross-channel identity normalization**: the same user's identities across
  different channels are multiple alias Snapshots of the same Entity (a
  `same_as` association) — humans and agents share the same identity model.

---

## 13. Skill Ecosystem

### 13.1 Export (system → outside world)

When a Lesson crosses the "export threshold", CrystallizeWorker exports it as
an `agentskills.io`-format `SKILL.md` — this is the channel through which the
system shares what it has learned with the outside world.

### 13.2 Install Side: Search / Install / Inspect Community Skills

```sh
# Search (queries both agentskills.io and clawhub registries)
memex skills search "code review"

# Install (runs a skills-guard security scan before download)
memex skills install agentskills.io <skill-id> [local-name]

# If the scan finds suspicious patterns (prompt injection, hidden
# instructions, credential harvesting, encoded payloads, etc.), the
# install is withheld and the findings are printed; if you've reviewed
# them and want to proceed anyway:
memex skills install agentskills.io <skill-id> --yes-despite-findings

# Inspect already-installed skills (re-runs the guard scan)
memex skills inspect [name]
```

Installed skills live under the active profile's `skills/` directory
(`~/.memex/skills/` or `~/.memex/profiles/<name>/skills/`).

> skills-guard is a **review aid, not a security boundary** — it reduces risk
> but does not replace human review. True execution isolation comes from the
> containerized execution backend described in section 14.

---

## 14. Security & Trust Model

**Core principle: no in-process mechanism is a security boundary. Only
OS-level isolation (containers) provides true containment.** The full threat
model is in [SECURITY.md](../SECURITY.md). This section is a configuration-level
overview.

### 14.1 `execute_bash` and CommandGate

The `execute_bash` MCP tool is **disabled by default**:

```env
EXECUTE_BASH_ENABLED=true
EXECUTE_BASH_CWD=/path/to/sandbox   # defaults to the system temp directory
```

Every command passes through a three-tier CommandGate:

1. **Hardline blocklist** — never bypassable by any mode; rejected immediately.
2. **Pattern-based approval** — dangerous-but-not-fatal commands require
   approval (see below).
3. **Optional aux-LLM smart approval** — can only make approval requirements
   *stricter*, never relax the hardline or pattern-approval verdicts.

Blocked attempts are written to the graph as audit events
(`memex::security::*`).

**Execution backends:**

- `local` (default, development mode) — runs with the host's own privileges,
  **not a security boundary**.
- `docker` backend — `--cap-drop ALL` plus a minimal `--cap-add`,
  `no-new-privileges`, `--pids-limit`, nosuid/noexec tmpfs; commands inside the
  container bypass approval (destructive commands inside the container can't
  reach the host); orphan containers are automatically reaped. The backend is
  selected in `~/.memex/config.json`.

### 14.2 Cross-Channel Approval Flow

Approval requests for dangerous commands are pushed to the home channel via
the DeliveryRouter; the user replies `/approve` or `/deny`. **Silence means
deny** — a 5-minute timeout automatically rejects. Approval scope can be
`once` (this request only) / `session` (this session) / `always` (written to
the config allowlist permanently).

### 14.3 Right to Erasure (`erase`)

```sh
# Trigger a data-erasure workflow for a Scope via CLI/API
```

`erase(scope)` will: destroy that Scope's data-encryption key (DEK), cascade
delete derived memory rows and embeddings, and write a content-free
`memex::payload::erase` audit event — the hash chain's integrity remains
intact.

**Known limitations** (important to understand):
- Content already written to backups cannot be reached by `erase` —
  **backup retention period = erasure-effectiveness delay**, and
  `memex backup` prints this notice on every run.
- Until the next reinforcement cycle, a related Lesson may still retain an
  abstract insight distilled from the erased Scope (never the verbatim
  content).

### 14.4 Trust Levels & Secrets

- `untrusted` sources (e.g. inbound webhooks) are restricted to a
  "webhook-safe" toolset and cannot reach file/command-execution tools.
- Two-stage environment-variable filtering: a blocklist of sensitive
  substrings, then a safe-prefix allowlist; `LD_PRELOAD`/`PYTHONPATH`/`PATH`
  etc. can never be written by agent actions.
- Known PII patterns are redacted before content is sent to the LLM and
  before it is written to the ledger.

### 14.5 Realtime Endpoint Protection

The WS/SSE endpoints use token auth (constant-time comparison) plus
connection/message rate limits, and bind to `localhost` by default —
exposing the Gateway is an explicit operator decision (use a reverse proxy +
TLS).

---

## 15. Operations: Diagnostics / Backup / Service / Multi-Environment

### 15.1 `memex doctor` — One-Shot Diagnostics (read-only, never changes config)

```sh
memex doctor
```

Eight independent checks: config file, Node version, Postgres connectivity +
extensions (pgvector/pgcrypto), migration watermark, **sampled hash-chain
integrity verification** (including the `erased_at` rule), each LLM provider's
connectivity, Gateway liveness, and channel token validity. If any check
`fail`s, the process exits non-zero (suitable for CI/health checks).

### 15.2 Backup & Restore

```sh
memex backup [output-dir]      # default ~/.memex/backups; pg_dump custom format
memex restore <backup-file>    # pg_restore, then re-verify the hash chain
```

> Note: backups include everything written before any `erase` — see the
> "backup retention period" note in section 14.3.

### 15.3 System Service (auto-start on boot)

```sh
memex service
```

Generates, under `./service-files/`, platform-appropriate files:

- Linux → a systemd unit file
- macOS → a launchd plist
- Windows → a Scheduled Task registration script

Each file comes with "how to register it" instructions — the CLI only
generates files; you run the registration step yourself.

### 15.4 Multi-Environment / Remote Core

- `MEMEX_PROFILE=<name>` — see section 5.5; isolates both configuration and
  database.
- Remote Gateway: set `shell.gateway_url` in a profile to point at a remote
  Core address; MemexTerminal / Dashboard / `memex connect` on this machine
  will then connect to that remote instance — enabling "my desktop and laptop
  share the same graph" cross-machine continuity. TLS is the responsibility of
  your reverse proxy.

---

## 16. Troubleshooting

| Symptom | What to check |
|---|---|
| `memex doctor` reports missing Postgres extensions | Confirm you're using the `pgvector/pgvector:pg16` image; manually run `CREATE EXTENSION vector; CREATE EXTENSION pgcrypto;` |
| Gateway fails to start with a port mismatch | Check that `.env`'s `PORT` and `iii-config.yaml`'s `III_URL` port match `iii-worker-manager.config.port` |
| MCP requests return 401 `Agent not paired` | When `REQUIRE_AGENT_PAIRING=true`, complete the pairing flow in section 6.1 first |
| `execute_bash` returns `BLOCKED (hardline)` | The command matched the hardline blocklist and cannot be bypassed; `BLOCKED (requires approval)` means it needs the section 14.2 approval flow |
| Writing an event returns 409 `scope suspended` | The Scope has been suspended and all writes are rejected (ADR-39) — check whether the convergence watchdog fired |
| Skill install is withheld | skills-guard found suspicious patterns; read the printed findings, and if they're fine, re-run with `--yes-despite-findings` |
| Log volume grows abnormally | Check whether `iii-observability.sampling_ratio` in `iii-config.yaml` was changed back to `1.0` (should stay `0.1`) |
| A connector isn't working | Confirm the required environment variables are set (see the table in 11.1), and use `memex doctor` to check token validity |

For developer-side troubleshooting, see "Common Setup Issues" in
`docs/guides/getting-started.md`.

---

## 17. Reference

- [docs/QUICKSTART.md](QUICKSTART.md) — five-minute getting started
- [docs/api/reference.md](api/reference.md) — full REST + MCP API reference
- [docs/guides/getting-started.md](guides/getting-started.md) — source development setup
- [docs/guides/configuration.md](guides/configuration.md) — full environment variable reference
- [docs/guides/deployment.md](guides/deployment.md) — deployment details
- [docs/guides/development.md](guides/development.md) — workflow for adding Workers/routes
- [SECURITY.md](../SECURITY.md) — trust model and vulnerability disclosure
- [CHANGELOG.md](../CHANGELOG.md) — release notes
- [docs/adr/](adr/) — all architectural decision records (ADR-01 through ADR-49)
- [.harness/ROADMAP.md](../.harness/ROADMAP.md) — project roadmap and per-phase deliverables
