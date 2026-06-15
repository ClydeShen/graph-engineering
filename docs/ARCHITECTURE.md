<!-- generated-by: gsd-doc-writer -->
# Memex — Graph-Native Agent Runtime: Architecture

> "The human mind operates by association. With one item in its grasp, it snaps instantly to the next
> that is suggested by the association of thoughts, in accordance with some intricate web of trails
> carried by the cells of the brain."
> — Vannevar Bush, *As We May Think* (1945)

---

## 1. System Overview

Memex is a graph-native runtime that externalizes AI agent cognition into an append-only causal graph
stored in PostgreSQL. Every agent action, memory write, conflict, and task transition becomes an
immutable node in the Trail Mesh — the system's single source of truth. There is no workflow engine,
no DAG authoring tool, and no pipeline configuration layer. What appear to be "workflows" are
statistical patterns that emerge from accumulated execution trails and are discovered automatically by
the PatternDiscoveryWorker.

Three core principles govern all design decisions:

- **Immutable append-only ledger** — state changes are new graph nodes (Versions), never overwrites.
  The `execution_event_log` is partitioned by scope, constrained by `UNIQUE(predecessor_hash, scope_id)`,
  and hashed by `pgcrypto` SHA-256 inside the database.
- **Context is a projection** — the LLM's context window is assembled per call from the graph's
  causal lineage (Knapsack Slicing). `Graph → Context`, never `Context = State`.
- **Choreography, not orchestration** — Workers subscribe to the iii Engine event bus and react to
  events; there is no central controller. Control flow advances through decentralized event subscriptions.

---

## 2. Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Knowledge Layer (SSOT)                                                   │
│  PostgreSQL — execution_event_log (partitioned) + four memory tables      │
│  pgcrypto SHA-256 · pgvector HNSW · pg_notify                             │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │ DDL (exclusive) / SELECT + INSERT / LISTEN/NOTIFY
┌───────────────────────────▼─────────────────────────────────────────────┐
│  Control Layer (Brain)                                                    │
│  @graph/control-plane — Pulse-Fetch bridge, Convergence Watchdog, DDL    │
│  @graph/gateway       — Hono HTTP server, MCP Streamable HTTP, REST       │
│  iii Engine binary    — Worker registry, WebSocket push, HWM advance      │
└───────────────────────────┬─────────────────────────────────────────────┘
                            │ WebSocket ws://localhost:49134 / HTTP :3000
┌───────────────────────────▼─────────────────────────────────────────────┐
│  Execution Layer (Limbs)                                                  │
│  @graph/workers — 12 iii-registered Workers (SELECT/INSERT only)          │
│  External agents — MCP / A2A / iii protocol, registered in agent_registry │
└─────────────────────────────────────────────────────────────────────────┘
```

**MemexCore** is the graph engine implemented in this repository (all packages below). **MemexShell**
(a future interactive layer) is not yet implemented.

---

## 3. Package Structure

| Package | Name | Runtime | Responsibility |
|---|---|---|---|
| `packages/gateway` | `@graph/gateway` | Bun | Hono HTTP server (port 3000), REST endpoints, MCP Streamable HTTP server, agent pairing |
| `packages/control-plane` | `@graph/control-plane` | Node.js/tsx | Pulse-Fetch bridge (pg-listen → HWM → iii.trigger), Convergence Watchdog, DDL-exclusive pool for scope nesting |
| `packages/workers` | `@graph/workers` | Node.js/tsx | All 12 iii-registered Workers plus context assembly (Knapsack Slicing, overflow handling) |
| `packages/shared` | `@graph/shared` | Both | `occWrite`, `occWriteIdempotent`, canonical JSON, OCC Writable CTE SQL, tokenizer, LLM provider abstraction, logger, write guard, command gate, `pg_notify` helper |
| `packages/cli` | `@graph/cli` | Node.js | `graph-runtime connect` TUI — patches `~/.claude.json` for Claude Code MCP, installs Pi Terminal extension |
| `packages/gateway-bot` | `@graph/gateway-bot` | Node.js/tsx | Telegram (long-poll or webhook) and Discord (slash commands) messaging bridge; dispatches messages as `task_spawned` events |
| `packages/pi-extension` | `@graph/pi-extension` | Pi Terminal SDK | Pi Terminal extension with rehearsal (shadow) mode, `spawn_task`/`complete_task` tools, `/fork-ext` and `/fork-end` commands |

**Dependency direction:** `gateway` → `workers`, `control-plane`, `shared`. `workers` → `shared`. No
package imports from `gateway`.

---

## 4. Data Flow: Agent → Graph → Workers

The canonical write path for an external agent using the REST API:

```
Agent (MCP / REST / Telegram / Discord)
  │
  │ POST /v1/scopes/:id/events  { event_type, entity_id, predecessor_hash, payload }
  ▼
@graph/gateway (Hono, Bun)
  │ Zod validation (400 before any DB access)
  │ occWrite() → OCC_WRITE_SQL (partitioned INSERT)
  ▼
PostgreSQL: execution_event_log_scope_{id}
  │ UNIQUE(predecessor_hash, scope_id) — first-writer-wins OCC
  │ pgcrypto digest() computes version_hash in-transaction
  │ pg_notify('graph_event_ready', '{"id": N}')   ← ≤64B pulse only
  ▼
@graph/control-plane: Pulse-Fetch bridge (pg-listen)
  │ Point-query by BIGSERIAL id — fetches full event row
  │ advanceHwm() — updates bus_state.last_processed_event_id
  │ Routes sub_scope_resolved → graph::scope::sub_scope_resolved topic
  │ All other events → graph::scheduler::frontier
  │                  + graph::memory::episodic   (task_spawned / memory_updated)
  ▼
iii Engine binary (WebSocket ws://localhost:49134)
  │ DashMap in-memory subscription routing
  │ WebSocket push to subscribed Workers
  ▼
@graph/workers
  │ FrontierSchedulerWorker → marks pending_dispatch (SKIP LOCKED claim-ready)
  │ EpisodicMemoryWorker    → appends to episodic_memory
  │ Agent claims via MCP claim_next_task → SKIP LOCKED → SET status='processing'
  │ Agent completes via MCP complete_task → occWrite (memory_updated)
  ▼
PostgreSQL (new event row) → pg_notify → loop
```

**OCC outcome signals** returned to the caller:
- `occ_result: 'won'` — first writer claimed the predecessor_hash slot
- `occ_result: 'demoted'` — late writer; event stored as `conflict_detected`, `ConflictResolverWorker` triggered

After each event write the Gateway also runs the inline Convergence Watchdog SQL. If all tasks are
complete and no conflicts are open, it writes `scope_closed` directly (infra-write right).

---

## 5. Key Data Models

### Five Canonical Event Types

Only these five event types are accepted by the database `CHECK` constraint on `execution_event_log`:

| Event type | Who writes it | Meaning |
|---|---|---|
| `plan_created` | Control Plane (scope init) | Scope root node; `predecessor_hash = ZERO_HASH` |
| `task_spawned` | Agents, `spawn_subtask` MCP tool | Sub-task created; `status = 'pending_scheduling'` |
| `memory_updated` | Agents, Workers | Task completed or memory advanced; carries full payload snapshot |
| `conflict_detected` | OCC CTE (automatic) | Late-arriving write; triggers `ConflictResolverWorker` |
| `scope_closed` | Gateway (inline Watchdog) | Scope converged; triggers cold-archive and memory synthesis |

Infrastructure-level direct writes (`context_oom_throttled`, `sub_scope_resolved`) bypass the CHECK
constraint and are written by the Control Plane or Gateway directly.

### Scope

A Scope groups all events for one top-level task. Each Scope gets its own LIST partition sub-table
(`execution_event_log_scope_{uuid_no_dashes}`) with two unique constraints:

- `UNIQUE(predecessor_hash, scope_id)` — OCC first-writer-wins
- `UNIQUE(scope_id, entity_id, version_hash)` — idempotent re-delivery

The `scope_id` is injected into the SHA-256 hash formula as a cryptographic salt, giving each Scope
collision-isolated hash space.

### Entity and Version

An Entity is a stable UUID business object. A Version is its immutable state at one point in time,
identified by:

```
version_hash = SHA-256(scope_id | entity_id | predecessor_hash | event_type | canonical_json(payload))
```

The hash is computed exclusively by `pgcrypto digest()` inside the Writable CTE. Application code
never computes the hash. Payload is stored as `TEXT` (never `JSONB`) to preserve canonical key order.

### HyperEdge (Association)

Each row in `execution_event_log` is a HyperEdge: a directed immutable tuple
`(source_entity, target_entity, event_type, version_hash, timestamp)`. The `predecessor_hash` chain
forms a blockchain-style append-only version history.

### ZERO_HASH

The sentinel value `"0000...0000"` (64 zero hex chars) used as the `predecessor_hash` for all
`plan_created` root nodes. Because any real hash cannot collide with this value (2⁻²⁵⁶ probability),
it safely prevents duplicate scope initialization via the unique constraint.

---

## 6. Worker Registry

All Workers are registered at boot in `packages/workers/src/index.ts` using `registerWorker` from
`iii-sdk`. Workers hold only `SELECT/INSERT` database rights — no DDL.

| Worker | iii function ID | Trigger | What it does |
|---|---|---|---|
| **FrontierSchedulerWorker** | `graph::scheduler::frontier` | durable:subscriber on `graph::frontier::changed` | LLM-free priority dispatch: computes `base_priority×10 + age_bonus + unlocks×5 + spawned_by_bonus + active_bonus`; marks rows `pending_dispatch` via `SKIP LOCKED`-safe UPDATE |
| **EpisodicMemoryWorker** | `graph::memory::episodic` | durable:subscriber on `graph::memory::episodic::ingest` | Appends `task_spawned` and `memory_updated` events to `episodic_memory`; fired by Pulse-Fetch on every non-self event |
| **SemanticMemoryWorker** | `graph::memory::semantic` | durable:subscriber on `graph::scope::closed` | Distils episodic records into `semantic_memory` via LLM on scope close |
| **MemorySynthesizerWorker** | `graph::memory::synthesizer` | cron 2AM daily | Batch episodic→procedural distillation for scopes with records in the past 25 hours; chains into ProceduralMemoryWorker |
| **ProceduralMemoryWorker** | `graph::memory::procedural` | durable:subscriber on synthesizer output | Stores WL-embedded workflow templates into `procedural_memory` with intent embedding |
| **ConflictResolverWorker** | `graph::conflict-resolver` | explicit trigger on `conflict_detected` | LLM-assisted semantic merge of conflicting OCC writes; writes `v_merged` with a `convergence_gate` payload |
| **SubScopeResultWorker** | `graph::scope::sub-scope-result` | durable:subscriber on `graph::scope::sub_scope_resolved` | Reads child scope final node, synthesizes result via LLM, writes `memory_updated` to parent scope |
| **CrystallizeWorker** | `graph::memory::crystallize` | durable:subscriber on `graph::scope::closed` | Real-time LLM digest of episodic records into a Crystal entity; triggers `LessonSaveWorker` |
| **LessonSaveWorker** | `graph::memory::lesson-save` | durable:subscriber on `graph::memory::lesson-save` | Content-addressed dedup via SHA-256 fingerprint; Ebbinghaus confidence reinforcement (`confidence += 0.1 × (1 − confidence)`); exports to `skills/` when threshold crossed |
| **PatternDiscoveryWorker** | `graph::patterns::discover` | cron every 6 hours | WL graph-kernel cross-domain cluster discovery; guarded by `MIN_CORPUS_THRESHOLD`; writes `cross_domain_cluster_id` to `procedural_memory`; base_priority=1 (lowest) |
| **McpClientWorker** | `graph::integration::mcp-client` | boot + manual trigger | Connects to external MCP servers; registers per-tool iii functions dynamically at startup |
| **UserProfileWorker** | `graph::memory::user-profile` | cron 3AM daily | Synthesizes cross-scope user profile from Crystal entities for all `protocol='human'` agents |

Cron workers (`MemorySynthesizerWorker` decay + TTL variants are also registered):
- `graph::memory::decay` — 3AM daily, Ebbinghaus decay scan
- `graph::memory::ttl` — 4AM daily, working_memory 24h TTL purge

---

## 7. MCP Server Tools

The MCP server (`/mcp`, `/mcp/messages`) implements the MCP Streamable HTTP 2025-11-25 spec via
`WebStandardStreamableHTTPServerTransport` (stateless — fresh transport per request). SSE at
`/mcp/sse` carries availability signals only (no task content).

Tools live in a registry (`mcp/tools/` — `core.ts`, `autonomy.ts`, `exec.ts`); `buildMcpServer`
loops it and registers each enabled tool. Two are env-gated (`execute_bash` →
`EXECUTE_BASH_ENABLED`, `browser` → `MEMEX_BROWSER_ENABLED`) and skipped when their flag is unset.
Trust gating (which principal may call which tool) happens at the HTTP `/mcp` route, not here.

| Tool | Description |
|---|---|
| `spawn_subtask` | Write a `task_spawned` event via OCC. D-1 guard rejects `assigned_agent_id` or `preferred_agent` in payload; routing is by `required_skills` only. Returns `{ task_id }`. |
| `claim_next_task` | `FOR UPDATE SKIP LOCKED` on `execution_event_log` filtered by `skills` and optionally `scope_id`. Returns task or `{}`. |
| `get_task_status` | Query latest `status`, `version_hash`, `scope_id`, `event_type` for an entity UUID. |
| `complete_task` | Write a `memory_updated` event via OCC to mark a task completed. Looks up `scope_id` and `predecessor_hash` from ledger if not supplied. |
| `wait_all_tasks` | Poll until all specified task UUIDs reach a terminal status (`completed`/`done`) or timeout. Returns `{ timed_out, completed, pending }`. |
| `register_agent` | Upsert an external AgentCard into `agent_registry` (`ON CONFLICT DO UPDATE` refreshes heartbeat). Returns `{ registered: agent_id }`. |
| `query_context` | Return the most recent N events for a `scope_id`. |
| `execute_bash` | Execute a shell command (env-gated `EXECUTE_BASH_ENABLED`). Gated by `CommandGate` (hardline and dangerous commands blocked). Shared impl with the in-process Pi terminal (ADR-57). Writes result as `memory_updated` audit event. |
| `ask_user` | Ask the human a free-form question; returns `question_id` immediately. Poll `ask_user_status`. Silence (10 min) = `timed_out`. (ADR-53) |
| `ask_user_status` | Check an `ask_user` question: `pending` \| `answered` (+answer) \| `timed_out`. |
| `capability_search` | Search installable capabilities (presets + skill registries) for an ability the agent lacks. (ADR-51) |
| `capability_install` | Two-phase install: first call files a human approval (guard scan in the body) and returns `approval_id`; re-call with `approval_id` to execute. An agent cannot grant itself authority. (ADR-53) |
| `browser` | Controlled browser action inside an isolated container (`navigate` \| `read` \| `fill` \| `click` \| `screenshot`); env-gated `MEMEX_BROWSER_ENABLED`. Screenshots are saved as artifacts (ADR-52). |

---

## 8. REST Endpoints

Three REST endpoints are mounted on the Hono app at port 3000:

```
POST /v1/scopes              — Create a new Scope (delegates DDL to Control Plane)
POST /v1/scopes/:id/events   — Submit an event (OCC write + inline Watchdog + context assembly)
GET  /v1/scopes/:id          — Read scope state + assembled context
GET  /v1/health              — Health check
GET  /v1/topology            — Graph topology query
POST /v1/memory              — Memory retrieval endpoint
POST /v1/agents/register     — Register an external agent AgentCard
GET  /.well-known/agent-card.json — graph-os self AgentCard (static, no DB)
POST /pair/generate          — Admin: generate agent pairing code (Bearer token gated)
POST /pair                   — Agent: verify pairing code, mark as paired
```

---

## 9. PostgreSQL Schema Overview

All migrations are in `migrations/` and applied via `scripts/migrate.ts`.

### Core event table

```sql
-- Partitioned BY LIST(scope_id); one sub-table per Scope
execution_event_log (
  id               BIGSERIAL,        -- surrogate, auto-increment per partition
  scope_id         UUID NOT NULL,    -- partition key
  entity_id        UUID NOT NULL,    -- stable business object UUID
  event_type       TEXT CHECK (...), -- five canonical types only
  predecessor_hash TEXT NOT NULL,    -- SHA-256 of prior version (ZERO_HASH for root)
  version_hash     TEXT NOT NULL,    -- pgcrypto SHA-256, computed in-transaction
  payload          TEXT NOT NULL,    -- pre-serialized canonical JSON (NEVER JSONB)
  status           TEXT DEFAULT 'pending_scheduling',
  base_priority    INT DEFAULT 1,
  unlocks_count    INT DEFAULT 0,
  spawned_by       UUID,
  last_active_at   TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope_id, id)
) PARTITION BY LIST (scope_id);
```

Per-partition constraints (created by Control Plane DDL at scope init):
- `UNIQUE(predecessor_hash, scope_id)` — OCC first-writer-wins
- `UNIQUE(scope_id, entity_id, version_hash)` — idempotent re-delivery

### Memory tables

| Table | Purpose | Indexes |
|---|---|---|
| `episodic_memory` | Concrete past event records; what happened and when | GIN `ts_doc` (BM25), B-tree `scope_id` |
| `semantic_memory` | Distilled cross-scope knowledge facts | GIN `ts_doc`, B-tree `scope_id`; `embedding vector(1536)` (HNSW pending) |
| `procedural_memory` | Reusable execution topology templates | GIN `ts_doc`; HNSW on `topology_embedding vector(128)` (partial: `WHERE is_anti_pattern = FALSE`); `fingerprint_id` unique (lesson dedup) |
| `working_memory` | Transient within-scope working state; expires with Scope | GIN `ts_doc`, B-tree `scope_id` |

### Infrastructure tables

| Table | Purpose |
|---|---|
| `bus_state` | HWM: `last_processed_event_id` per worker ID; enables gap-free replay on reconnect |
| `scope_lineage` | Parent-child Scope causality metadata; written atomically in DDL transaction at nesting time |
| `agent_registry` | AgentCard store for all registered agents (internal Workers + external MCP/A2A); includes `skills TEXT[]`, `protocol`, `last_heartbeat`, `status` |
| `worker_profiles` | Per-(worker_type, model_fingerprint) `△_padding` token buffer; auto-adapts to real LLM usage |

---

## 10. Event Chain Diagram (ASCII)

```
New Scope request
      │
      ▼
Control Plane: 3-phase DDL
  ├── CREATE TABLE execution_event_log_scope_{id} PARTITION OF ...
  ├── ADD CONSTRAINT uk_occ_{id} UNIQUE(predecessor_hash, scope_id)
  └── CREATE INDEX HNSW ...

Gateway: INSERT plan_created (predecessor_hash = ZERO_HASH)
      │
      ▼ pg_notify('graph_event_ready', '{"id":1}')
      │
Pulse-Fetch (pg-listen): point-query → advanceHwm
      │
      ├──► iii.trigger('graph::scheduler::frontier', {scope_id})
      │         └► FrontierSchedulerWorker: marks rows pending_dispatch
      │
      └──► iii.trigger('graph::memory::episodic', {scope_id, content, ...})
                └► EpisodicMemoryWorker: appends to episodic_memory

Agent (MCP): claim_next_task → SKIP LOCKED → status='processing'
Agent (MCP): complete_task  → occWrite → memory_updated
      │
      ▼ pg_notify → Pulse-Fetch → FrontierScheduler + Episodic loop

[Concurrent write race]
  Worker A: occWrite → WON   → memory_updated (H_v1)
  Worker B: occWrite → DEMOTED → conflict_detected (H_v2, predecessor=H_v1)
      │
      ▼ pg_notify → ConflictResolverWorker
  LLM merge → INSERT v_merged (convergence_gate payload)

[All tasks pending=0, conflicts=0]
Gateway inline Watchdog: INSERT scope_closed
      │
      ├──► CrystallizeWorker:    episodic records → Crystal → LessonSaveWorker
      │        └► LessonSaveWorker: fingerprint dedup, Ebbinghaus confidence
      │
      ├──► SemanticMemoryWorker: episodic → semantic_memory via LLM
      │
      └──► PatternDiscoveryWorker (6h cron):
               topology clustering → cross_domain_cluster_id
```

---

## 11. Concurrency and OCC

The system enforces optimistic concurrency at the database level. No application-level locking exists.

The Writable CTE (`OCC_WRITE_SQL`) is a three-branch SQL transaction:

1. `attempt` — try to INSERT with the claimed `predecessor_hash`; `ON CONFLICT DO NOTHING`
2. `winner` — find whichever row now holds that slot
3. `conflict` — if `attempt` returned 0 rows, INSERT a `conflict_detected` row chained after the winner

The result is always a row with `occ_result='won'` (claimed) or `occ_result='demoted'` (conflict
recorded). No retry, no exception, no rollback — the losing write is preserved in the ledger as a
`conflict_detected` node, which is signal, not error.

---

## 12. Knapsack Slicing (Context Assembly)

When the Gateway assembles context after an event write (for return to the calling agent), it calls
`assembleContext` from `@graph/workers/context/assemble`. The algorithm:

1. Load `N_root` (the `plan_created` node — rigid causal anchor)
2. Load `N_current` (the event just written)
3. Load sibling nodes (`pending_scheduling` / `conflict_detected` in the same scope)
4. Fill ancestor chain (newest-first along `predecessor_hash`) within `W_max` token budget
5. If `N_root + N_current > W_max` → trigger Context OOM three-level degradation:
   - Level 1: LLM distillation of `N_root` to 10–20% original size
   - Level 2: tail-truncate `N_current` to min(2000, remaining budget) tokens
   - Level 3: write `context_oom_throttled` directly; Scope enters Suspended state

---

## 13. Four-Layer Memory and Retrieval

Agents access historical knowledge through the Divergent Reflection Track, triggered only in three
scenarios: `conflict_detected`, global macro-planning, or cold-start Scope initialization.

```
[EXECUTION CONTEXT]  — Knapsack causal chain (deterministic, always present)
[REFLECTION MEMORY]  — BM25 + HNSW RRF retrieval (on-demand, token-capped)
  Procedural  (LIMIT 1–3,  budget × 0.6)  — workflow templates + anti-patterns
  Episodic    (LIMIT 5,    remaining)       — past scope outcomes
  Semantic    (LIMIT 5,    remaining)       — distilled facts (WHERE superseded_by IS NULL)
```

Retrieval is hybrid: `ts_doc` BM25 full-text (GIN index) combined with `pgvector` HNSW cosine
similarity, merged via Reciprocal Rank Fusion (RRF k=60). Token budget: `min(2000, W_max × 0.3)`.

---

## 14. Agent Connectivity

Three protocols for connecting agents to the runtime:

| Protocol | Entry point | Notes |
|---|---|---|
| **MCP** | `POST /mcp` or `/mcp/messages` | MCP Streamable HTTP 2025-11-25; 8 tools; optional agent pairing (`REQUIRE_AGENT_PAIRING=true`) |
| **A2A** | `GET /.well-known/agent-card.json` | graph-os self AgentCard; external A2A agents register via `POST /v1/agents/register` |
| **iii** | `ws://localhost:49134` | Internal workers only; `registerWorker` + `registerFunction` |

The CLI (`graph-runtime connect`) patches `~/.claude.json` to wire Claude Code as an MCP client
and installs the Pi Terminal extension into `~/.pi/agent/extensions/`.

---

## 15. Related Documents

| Topic | Document |
|---|---|
| Canonical terminology (English + Chinese) | `CONTEXT.md` |
| Full ADR listing (ADR 01–40+) | `docs/ADR_v4.md` |
| Original system RFC | `docs/RFC_v4.md` |
| BM25+HNSW RRF hybrid retrieval | `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` |
| mem::reflect interface and token budget | `docs/adr/0022-adr21-reflection-track-trigger-spec.md` |
| Context OOM three-level degradation | `docs/adr/0024-adr13-supplement-context-oom-degradation.md` |
| Nested Scope propagation | `docs/adr/0025-adr23-nested-scope-propagation.md` |
| Cross-domain topology algorithm | `docs/adr/0027-adr25-cross-domain-topology-algorithm.md` |
| Event-as-Snapshot philosophy | `docs/adr/0028-adr26-event-as-snapshot-philosophy.md` |
| Frontier Scheduler architecture | `docs/adr/0033-adr31-frontier-scheduler-architecture.md` |
| PgQueueAdapter and idempotency | `docs/adr/0034-adr32-pgqueueadapter-and-idempotency.md` |
