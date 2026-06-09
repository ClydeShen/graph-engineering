# Phase 1: Core Graph Engine — Research

**Researched:** 2026-06-02
**Domain:** PostgreSQL append-only event graph · iii-sdk Worker framework · TypeScript Control Plane · HTTP Gateway (Hono) · Wasm tokenizer · FOR UPDATE SKIP LOCKED queue
**Confidence:** HIGH (core stack), MEDIUM (integration hazard patterns)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- `canonical_json` MUST be implemented in TypeScript via `Object.keys().sort()` recursive traversal (BTreeMap equivalent). PostgreSQL side receives pre-serialized TEXT — NEVER does `::jsonb` conversion. [ADR 02 P0-D]
- Version Hash formula: `pgcrypto.digest(scope_id|entity_id|predecessor_hash|event_type|canonical_json_text, 'sha256')` inside Writable CTE. [ADR 02]
- `graph_root` (plan_created) uses ZERO_HASH `0000...0000` (64 zeros) as predecessor_hash sentinel. [ADR 02]
- Hashable domain = `payload` minus `_meta` minus `schema_version` — both stripped by application layer BEFORE hash input.
- `execution_event_log`: PARTITION BY LIST(scope_id). Each Scope gets its own partition sub-table. [ADR 01]
- OCC hard-stop: `UNIQUE(predecessor_hash, scope_id)` constraint on each partition. First writer wins. [ADR 11]
- Five canonical event types ONLY: `plan_created`, `task_spawned`, `memory_updated`, `conflict_detected`, `scope_closed`. [ADR 12]
- Four memory tables with `ts_doc tsvector GENERATED ALWAYS` + `procedural_memory.topology_embedding vector(128)` with HNSW `m=16, ef_construction=64`. [ADR 20, ADR 25]
- OCC atomic causal inversion via single Writable CTE. No application callback, no `::jsonb` conversion. [ADR 11, ADR 02]
- Control Plane: TypeScript, two DB pools (DDL exclusive + event read/LISTEN), `pg-listen` for LISTEN/NOTIFY. [ADR 05, ADR 09]
- Pulse-Fetch Bridge: pg-listen fires callback → HWM advance → `iii.trigger()`. LISTEN/NOTIFY carries no data payload. [ADR 09, ADR 32]
- Convergence Watchdog embedded in Control Plane, NOT a separate Worker. [ADR 19]
- Worker lifecycle: Initializing → Processing → Writing → Terminated. ZERO persistent writes during Processing. [ADR 27]
- TypeScript ABCs: `Worker` holds `GraphHandle` (write), `Tool` holds `ReadOnlyGraphHandle` (no write). Compile error + DI SecurityException. [ADR 35]
- HTTP Gateway: Hono or Fastify. Three endpoints. Inline Watchdog SQL. Direct-write rights for `scope_closed` and `context_oom_throttled`. [ADR 24]
- Zod validation: UUID v4 regex, `/^[0-9a-f]{64}$/` for hash fields. Failure → 400. [ADR 24]
- `PgQueueAdapter` with `FOR UPDATE SKIP LOCKED`. `IQueueAdapter` abstraction. [ADR 32]
- Frontier Scheduler: `graph::scheduler::frontier` Worker. Token bucket 50ms. Priority SQL. [ADR 31]
- Context Assembly: 3-layer prompt. Zero-LLM sliding window overflow. [ADR 30]
- Phase 1 implements exactly ONE LLM provider: OpenAI-compatible REST. [ADR 22]
- Pattern Discovery: `base_priority=1`, cron every 6h, MIN_CORPUS=10 guard. [ADR 37]

### Claude's Discretion

- TypeScript project structure, module layout, file naming
- iii-config.yaml format and configuration values
- Specific table column types beyond what ADRs specify
- Test framework and test file locations
- Error message strings
- Logging format
- HTTP port configuration
- Development vs production config separation

### Deferred Ideas (OUT OF SCOPE)

- BM25+RRF retrieval queries (Phase 2)
- ConflictResolverWorker LLM-assisted merge (Phase 2)
- MemorySynthesizer (Phase 2)
- Nested scope full activation (Phase 3)
- Redis queue adapter (Phase 2)
- MCP adapter (Phase 2+)
- Pi sandbox (Phase 4)
- Distributed locks (Phase 4)
- G1-G4 deferred research items
- `IOverflowStrategy` activation
- `pgvector 0.8.0 hnsw.iterative_scan` optimization (Phase 3)
- SubScopeResultWorker (Phase 3)
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| REQ-01 | `execution_event_log` PARTITION BY LIST(scope_id), `UNIQUE(predecessor_hash, scope_id)` per partition | DDL pattern verified; partition sub-table naming convention documented |
| REQ-02 | All version_hash via pgcrypto `digest()` inside Writable CTE — application sends pre-serialized TEXT | Two-phase hash contract verified in ADR 02 and tech.md |
| REQ-03 | `canonical_json` via TypeScript BTreeMap-equivalent — corrected implementation in ADR 02 | Correct implementation with array double-encoding fix documented |
| REQ-04 | Four memory tables with tsvector GENERATED ALWAYS + topology_embedding vector(128) HNSW | HNSW partial index DDL verified via pgvector context7 |
| REQ-05 | `scope_lineage` cold table, written during DDL nesting protocol | Schema stub noted; not append-only |
| REQ-06 | Control Plane TypeScript, pg-listen for LISTEN/NOTIFY, iii.trigger() bridge, exclusive DDL pool | pg-listen API verified; iii-sdk registerWorker/trigger API verified |
| REQ-07 | 3-phase nesting protocol — all within single DDL transaction | DDL exclusive connection pool pattern documented |
| REQ-08 | Convergence Watchdog 3-tier defense, only emitter of `scope_closed`, embedded in Control Plane | SQL convergence query pattern documented |
| REQ-09 | Context OOM 3-tier degradation chain | Tier 1 annotated as LLM call; Tiers 2/3 are deterministic |
| REQ-10 | `@dqbd/tiktoken` Wasm tokenizer — 2-line load, sub-1ms encode | Exact pattern confirmed from TECH_STACK.md + ARCHITECTURE.md |
| REQ-11 | TypeScript ABC boundary: Worker/GraphHandle vs Tool/ReadOnlyGraphHandle + DI SecurityException | Full implementation pattern in ADR 35 |
| REQ-12 | Worker 4-phase lifecycle state machine, Knapsack failure bifurcation | ADR 27 full spec with TypeScript patterns |
| REQ-13 | Per-tool-result write with `ON CONFLICT DO NOTHING` | Idempotency key = version_hash; DO NOTHING pattern documented |
| REQ-14 | Subagent scope branching Phase 1 (in-process, MAX_DEPTH=3, spawned_by hyperedge) | Env guard `GRAPH_AGENT_CHILD_SCOPE` + payload field documented |
| REQ-15 | Hono Gateway, 3 endpoints, inline Watchdog SQL, direct-write rights | Hono 4.12.23 verified on npm; Zod integration pattern documented |
| REQ-16 | Zod validation UUID v4 + hash regex, 400 on failure | Exact regex patterns from ADR 24 documented |
| REQ-17 | PgQueueAdapter FOR UPDATE SKIP LOCKED, IQueueAdapter interface, backpressure at Max_Parallelism=4 | Full SQL + TypeScript from ADR 32 |
| REQ-18 | `UNIQUE(scope_id, entity_id, version_hash)` + `ON CONFLICT DO NOTHING` | ADR 32 D-5 pattern documented |
| REQ-19 | Frontier Scheduler Worker, 50ms token bucket, priority SQL Top-K | Full SQL with dynamic_score formula from ADR 31 |
| REQ-20 | 3-layer context assembly + Zero-LLM reverse-chronological overflow discarder | ADR 30 algorithm documented; IOverflowStrategy reserved but not activated |
| REQ-21 | LLMProvider + EmbeddingProvider interfaces, OpenAI-compatible REST, credentials in iii-config.yaml only | OpenAI-compatible endpoint pattern documented |
| REQ-22 | `graph::patterns::discover` cron Worker, base_priority=1, MIN_CORPUS=10 | iii-cron 7-field format verified; cron registration pattern documented |
| REQ-23 | Scope UUID orthogonal to context window size — UUID NEVER rotated on overflow | Design invariant confirmed; overflow handled by sliding window only |
</phase_requirements>

---

## Summary

Phase 1 builds the foundational execution graph runtime in TypeScript on top of the pre-installed iii engine binary. The architecture is three layers: PostgreSQL SSOT (our schema migrations), Control Plane Daemon (our TypeScript process connecting to iii via WebSocket), and Worker Layer (our TypeScript workers also connecting via iii-sdk). The iii engine is a pure event router — it has no awareness of execution graphs, hash chains, or OCC semantics. Every graph-specific concern lives in our code.

The most significant implementation risk is the two-phase hash contract (ADR 02): TypeScript must compute `canonical_json` using correct BTreeMap-equivalent key sorting before sending TEXT to PostgreSQL. A subtle bug in the prior implementation was found and corrected (array elements were double-serialized). The corrected pattern is documented in ADR 02 and reproduced in the Code Examples section.

The second major risk is the pg-listen integration: the library uses an EventEmitter pattern, not a `next()` async iterator. The deep-cross-validation research confirmed that `Client.notifications()` does not exist in node-postgres — pg-listen is the correct abstraction for LISTEN/NOTIFY in the TypeScript Control Plane. The iii-sdk `registerWorker()`/`registerFunction()` API is the correct integration point for the Worker Layer, not raw WebSocket code.

**Primary recommendation:** Structure the project as a TypeScript monorepo with three packages: `packages/control-plane` (pg-listen + iii-sdk bridge, DDL nesting, Watchdog), `packages/workers` (iii-sdk function registrations, ABC base classes), and `packages/gateway` (Hono + Zod + direct PG write). Share `packages/shared` for `canonicalJson`, Zod schemas, and type definitions. Each package connects to PostgreSQL independently with its own pool configured to its permission tier.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| PostgreSQL schema DDL (partitions, HNSW indexes) | Control Plane Daemon | — | DDL exclusive connection pool per ADR 05; Gateway and Workers have no DDL rights |
| LISTEN/NOTIFY subscription + HWM advance | Control Plane Daemon | — | pg-listen owns the subscriber connection; point-query on notification |
| Event routing to Workers (iii.trigger) | Control Plane Daemon | iii Engine (transport) | Pulse-Fetch bridge: PG notify → iii trigger |
| HTTP REST for external agents | Gateway (Hono) | — | POST /v1/scopes, POST /v1/scopes/:id/events, GET /v1/scopes/:id |
| OCC Writable CTE execution | PostgreSQL (pgcrypto) | TypeScript (canon JSON) | TypeScript prepares canonical_json_text; PostgreSQL executes digest() |
| Knapsack context assembly | Control Plane / Gateway | @dqbd/tiktoken | Token budget computed via Wasm tokenizer; graph queries via read pool |
| Worker function execution | Workers (iii-sdk) | iii Engine (dispatch) | registerFunction() handlers own all business logic |
| Frontier scheduling + priority | Frontier Scheduler Worker | PostgreSQL (priority SQL) | SQL Top-K + token bucket in Worker; iii is FIFO transport only |
| Convergence detection + scope_closed | Control Plane Daemon (Watchdog) | Gateway (inline SQL) | 3-tier defense embedded in Control Plane; Gateway inline on event POST |
| Token counting (W_max budget) | Control Plane / Workers | — | @dqbd/tiktoken Wasm, <1ms per call |
| LLM / Embedding calls | Workers | LLMProvider interface | Workers call interface; credentials only in iii-config.yaml |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `iii-sdk` | 0.17.0 | Worker registration, Function dispatch; `registerWorker()` + `registerFunction()` + `trigger()` | Only SDK for connecting to iii Engine binary; no alternative [VERIFIED: npm registry] |
| `pg` (node-postgres) | 8.21.0 | PostgreSQL client — Writable CTE INSERT, Scope DDL, direct queries | Standard PostgreSQL client for Node.js; Pool + Client pattern [VERIFIED: npm registry] |
| `pg-listen` | 1.7.0 | PostgreSQL LISTEN/NOTIFY subscriber — Pulse-Fetch bridge for Control Plane | Abstracts reconnect + EventEmitter for pg notifications; established since 2018 [VERIFIED: npm registry] |
| `hono` | 4.12.23 | HTTP Gateway framework — 3 REST endpoints + Zod middleware | Lightweight, first-class Zod/TypeScript support; smaller than Fastify for edge-adjacent [VERIFIED: npm registry] |
| `zod` | 4.4.3 | Input validation — UUID v4 + SHA-256 hash regex enforcement | Standard schema validation; ADR 24 Zod schemas [VERIFIED: npm registry] |
| `@dqbd/tiktoken` | 1.0.22 | Wasm tokenizer — W_max budget calculation, <1ms encode | Official tiktoken Rust→Wasm port; only package with accurate BPE counts in Node.js [VERIFIED: npm registry] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `tsx` | 4.22.4 | TypeScript execution for Node.js (dev + scripts) | Dev workflow; replace with compiled JS in production |
| `fastify` | 5.8.5 | Alternative HTTP Gateway | If Hono proves limiting; higher ecosystem maturity |
| `typescript` | latest 5.x | Type safety across all packages | Required for ABC compile-time enforcement (ADR 35) |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `pg` | `postgres` (postgres.js) | postgres.js has cleaner API but pg has broader ecosystem; both work for Writable CTEs |
| `hono` | `fastify` | Fastify has richer plugin ecosystem but heavier; Hono preferred per CONTEXT.md |
| `@dqbd/tiktoken` | `js-tiktoken` | js-tiktoken is pure JS but has BPE accuracy issues at boundary tokens; Wasm is authoritative |
| `pg-listen` | raw `pg` EventEmitter | pg-listen handles reconnect + channel management; raw pg requires manual reconnect loop |

**Installation:**
```bash
npm install iii-sdk pg pg-listen hono zod @dqbd/tiktoken
npm install -D tsx typescript @types/pg @types/node
```

**Version verification:** All versions confirmed via `npm view <pkg> version` on 2026-06-02.

---

## Package Legitimacy Audit

> slopcheck was run but operates against PyPI (Python package index). This is a Node.js project — slopcheck results are cross-ecosystem false positives. All packages verified directly against npm registry.

| Package | Registry | Age | Source Repo | npm verify | Disposition |
|---------|----------|-----|-------------|-----------|-------------|
| `iii-sdk` | npm | Active (0.17.0 current) | github.com/iii-hq/iii | `npm view iii-sdk version` → 0.17.0 | Approved — official SDK for iii engine binary |
| `pg` | npm | 12+ years | github.com/brianc/node-postgres | `npm view pg version` → 8.21.0 | Approved |
| `pg-listen` | npm | Since 2018 | github.com/andywer/pg-listen | `npm view pg-listen version` → 1.7.0 | Approved |
| `hono` | npm | Active | github.com/honojs/hono | `npm view hono version` → 4.12.23 | Approved |
| `zod` | npm | Active | github.com/colinhacks/zod | `npm view zod version` → 4.4.3 | Approved |
| `@dqbd/tiktoken` | npm | Active | github.com/dqbd/tiktoken | `npm view @dqbd/tiktoken version` → 1.0.22 | Approved |
| `fastify` | npm | 8+ years | github.com/fastify/fastify | `npm view fastify version` → 5.8.5 | Approved (alternative) |
| `tsx` | npm | Active | github.com/privatenumber/tsx | `npm view tsx version` → 4.22.4 | Approved |

**Note on slopcheck:** slopcheck v0.6.1 was installed and executed but checked PyPI (Python registry) — it flagged `pg-listen` and `hono` as SLOP because they do not exist on PyPI. This is a known slopcheck limitation for non-Python ecosystems. All packages above are verified on npm (Node.js registry) and are legitimate. The `iii-sdk` [SUS] flag from slopcheck (PyPI) is a false positive — the package is the official SDK for the iii engine, confirmed via github.com/iii-hq/iii. [CITED: github.com/iii-hq/iii]

**Packages removed due to slopcheck [SLOP] verdict:** none (all verdicts were cross-ecosystem false positives)
**Packages flagged as suspicious [SUS]:** none (all cleared via npm verification)

---

## Architecture Patterns

### System Architecture Diagram

```
External Agent (HTTP/curl/Claude Code)
         │
         ▼
┌─────────────────────────────────────────────┐
│  HTTP Gateway  (Hono, port 3000)            │
│  POST /v1/scopes → 3-phase DDL nesting      │
│  POST /v1/scopes/:id/events → OCC + context │
│  GET  /v1/scopes/:id → read scope state     │
│  Zod validation → 400 before any DB touch   │
│  Inline Watchdog SQL → scope_closed         │
└────────────────────┬────────────────────────┘
                     │ pg Pool (SELECT/INSERT only)
                     ▼
┌─────────────────────────────────────────────┐
│  Control Plane Daemon  (TypeScript process) │
│                                             │
│  pg-listen subscriber ──► HWM advance       │
│                       └──► iii.trigger()    │
│  DDL exclusive pool ──► CREATE PARTITION    │
│                     └──► HNSW index         │
│  Convergence Watchdog ──► scope_closed      │
│  @dqbd/tiktoken ──► W_max budget calc       │
└────────┬────────────────────────────────────┘
         │ WebSocket ws://localhost:49134
         ▼
┌─────────────────────────────────────────────┐
│  iii Engine Binary  (pre-installed)         │
│  Function Router · WebSocket Server         │
└────────┬────────────────────────────────────┘
         │ registerFunction() callbacks
         ▼
┌─────────────────────────────────────────────┐
│  Worker Layer  (TypeScript, iii-sdk)        │
│                                             │
│  StandardWorker extends Worker (GraphHandle)│
│  Tool implements Tool<I,O> (ReadOnlyHandle) │
│  FrontierSchedulerWorker ──► priority SQL   │
│  PatternDiscoveryWorker ──► cron, MIN=10    │
│  (ConflictResolverWorker — stub Phase 1)    │
└────────┬────────────────────────────────────┘
         │ pg Pool (SELECT/INSERT only)
         ▼
┌─────────────────────────────────────────────┐
│  PostgreSQL (SSOT)                          │
│  execution_event_log  PARTITION BY LIST     │
│  ├─ scope_<uuid> UNIQUE(pred_hash,scope_id) │
│  episodic_memory / semantic_memory          │
│  procedural_memory (vector(128) HNSW)       │
│  working_memory                             │
│  bus_state (HWM)                            │
│  scope_lineage                              │
│  Extensions: pgcrypto + pgvector            │
└─────────────────────────────────────────────┘
```

### Recommended Project Structure

```
packages/
├── shared/                    # Shared types, utilities (no runtime deps)
│   ├── src/
│   │   ├── canonical-json.ts  # canonicalJson() + hashablePayload()
│   │   ├── schemas.ts         # Zod schemas: EventBodySchema, UUIDs, hashes
│   │   ├── types.ts           # EventLogNode, GraphWriteEvent, WriteResult
│   │   └── constants.ts       # ZERO_HASH, EVENT_TYPES, MAX_PARALLELISM
│   └── package.json
│
├── control-plane/             # Pulse-Fetch bridge + DDL + Watchdog
│   ├── src/
│   │   ├── index.ts           # Entry point — boot order matters (see Pitfall 3)
│   │   ├── pulse-fetch.ts     # pg-listen subscriber → iii.trigger()
│   │   ├── nesting.ts         # 3-phase DDL nesting protocol
│   │   ├── watchdog.ts        # ScopeConvergenceTracker (3-tier defense)
│   │   ├── hwm.ts             # bus_state HWM advance
│   │   └── db/
│   │       ├── ddl-pool.ts    # Exclusive DDL connection (1-2 connections)
│   │       └── read-pool.ts   # Read-only point-query pool
│   └── package.json
│
├── workers/                   # iii-sdk Worker + Tool implementations
│   ├── src/
│   │   ├── base/
│   │   │   ├── worker.abstract.ts  # abstract Worker class (ADR 35)
│   │   │   ├── tool.interface.ts   # Tool<I,O> interface (ReadOnlyGraphHandle)
│   │   │   ├── graph-handle.ts     # GraphHandle (write capable)
│   │   │   └── read-only-handle.ts # ReadOnlyGraphHandleImpl + SecurityException
│   │   ├── scheduler/
│   │   │   └── frontier.worker.ts  # graph::scheduler::frontier
│   │   ├── patterns/
│   │   │   └── discover.worker.ts  # graph::patterns::discover (cron stub)
│   │   ├── context/
│   │   │   ├── knapsack.ts         # Knapsack Slicing algorithm
│   │   │   └── overflow.ts         # ReverseChronologicalDiscarder
│   │   └── index.ts               # registerWorker + registerFunction boot
│   └── package.json
│
├── gateway/                   # Hono HTTP Gateway
│   ├── src/
│   │   ├── index.ts           # Hono app + port bind
│   │   ├── routes/
│   │   │   ├── scopes.ts      # POST /v1/scopes
│   │   │   ├── events.ts      # POST /v1/scopes/:id/events
│   │   │   └── scope-read.ts  # GET /v1/scopes/:id
│   │   ├── middleware/
│   │   │   └── zod-guard.ts   # Zod validation → 400
│   │   └── watchdog-sql.ts    # Inline Watchdog SQL for Gateway
│   └── package.json
│
migrations/                    # PostgreSQL schema migrations (ordered)
│   ├── 001-extensions.sql     # pgcrypto + pgvector CREATE EXTENSION
│   ├── 002-event-log.sql      # execution_event_log parent table
│   ├── 003-memory-tables.sql  # episodic/semantic/procedural/working memory
│   ├── 004-bus-state.sql      # bus_state HWM table
│   ├── 005-scope-lineage.sql  # scope_lineage cold table (Phase 3 stub)
│   └── 006-worker-profiles.sql# △_padding per worker channel
│
iii-config.yaml                # iii engine configuration
package.json                   # workspace root
tsconfig.json                  # strict: true, paths aliases
```

---

### Pattern 1: iii-sdk Worker Registration (exact API)

**What:** How to connect a TypeScript process to iii Engine as a Worker and register function handlers.
**When to use:** Every Worker module and the Control Plane Daemon.

```typescript
// Source: [CITED: github.com/iii-hq/iii, iii.dev/docs/creating-workers/workers]
import { registerWorker } from 'iii-sdk';

const worker = registerWorker(process.env.III_URL ?? 'ws://localhost:49134', {
  workerName: 'control-plane',
});

// Register a function handler (function_id format: 'namespace::name')
worker.registerFunction('graph::scheduler::frontier', async (payload) => {
  // payload is the data passed via iii.trigger()
  await frontierScheduler.onFrontierChanged(payload);
  return { dispatched: true };
});

// Register a durable subscriber trigger (at-least-once delivery)
worker.registerTrigger({
  type: 'durable:subscriber',
  function_id: 'graph::scheduler::frontier',
  config: { topic: 'graph::frontier::changed' },
});

// Register a cron trigger (7-field: sec min hr day month weekday year)
worker.registerTrigger({
  type: 'cron',
  function_id: 'graph::patterns::discover',
  config: { expression: '0 0 */6 * * * *' },  // every 6 hours
});
```

**Key clarification:** `iii.trigger()` fires a function by ID without going through a queue or topic. Use `registerTrigger` + topic for event-driven subscriptions. [CITED: iii.dev/docs/creating-workers/workers]

---

### Pattern 2: pg-listen — Pulse-Fetch Bridge (exact API)

**What:** LISTEN/NOTIFY subscriber in TypeScript — the Pulse-Fetch bridge that feeds iii.trigger().
**When to use:** Control Plane Daemon only. Not used in Workers or Gateway.

```typescript
// Source: [CITED: github.com/andywer/pg-listen, npm pg-listen]
import createSubscriber from 'pg-listen';

const subscriber = createSubscriber({
  connectionString: process.env.DATABASE_URL,
});

// IMPORTANT: connect() must complete before any listenTo() calls
await subscriber.connect();

// Subscribe to the notification channel
await subscriber.listenTo('iii_engine_channel');

// Callback receives the raw notification payload string
subscriber.notifications.on('iii_engine_channel', async (rawPayload: string) => {
  const { id } = JSON.parse(rawPayload);  // ≤64B pulse per ADR 09

  // Point-query on read pool — notification carries ID only (no data)
  const event = await readPool.query(
    'SELECT * FROM execution_event_log WHERE id = $1',
    [id]
  );

  if (event.rows.length === 0) return;  // race condition: already processed

  // Advance HWM atomically
  await readPool.query(
    `UPDATE bus_state
     SET last_processed_event_id = $1
     WHERE worker_id = $2 AND last_processed_event_id < $1`,
    [id, CONTROL_PLANE_WORKER_ID]
  );

  // Route to iii Worker via trigger
  await iiiWorker.trigger({
    function_id: `worker::${event.rows[0].event_type}`,
    payload: event.rows[0],
  });
});

// pg-listen handles reconnection automatically — no manual reconnect needed
subscriber.events.on('error', (err) => {
  console.error('pg-listen error:', err);
  // pg-listen reconnects; do not exit process on error
});
```

**Critical API note:** pg-listen uses `.notifications.on(channel, cb)` — NOT `client.on('notification', cb)`. The channel name passed to `.listenTo()` MUST match the channel name in `.notifications.on()`. [CITED: npm pg-listen, github.com/andywer/pg-listen]

---

### Pattern 3: Hono Gateway with Zod Validation (exact API)

**What:** Hono v4 routes with Zod body validation, returning 400 on invalid input before any DB access.
**When to use:** HTTP Gateway — all three endpoints.

```typescript
// Source: [CITED: hono.dev docs, verified npm 4.12.23]
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const app = new Hono();

// Regexes from ADR 24
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_HEX64 = /^[0-9a-f]{64}$/;

const CreateScopeSchema = z.object({
  intent: z.string().min(1).max(4096),
});

const EventBodySchema = z.object({
  event_type: z.enum(['task_spawned', 'memory_updated', 'conflict_detected']),
  entity_id: z.string().regex(UUID_V4),
  predecessor_hash: z.string().regex(HASH_HEX64),
  payload: z.record(z.unknown()),
});

// POST /v1/scopes
app.post('/v1/scopes', zValidator('json', CreateScopeSchema), async (c) => {
  const { intent } = c.req.valid('json');
  // ... 3-phase DDL nesting protocol
  return c.json({ scope_id, plan_hash, context });
});

// POST /v1/scopes/:id/events
app.post(
  '/v1/scopes/:id/events',
  zValidator('json', EventBodySchema),
  async (c) => {
    const scopeId = c.req.param('id');
    if (!UUID_V4.test(scopeId)) return c.json({ error: 'invalid scope_id' }, 400);
    const body = c.req.valid('json');
    // ... OCC write + inline Watchdog SQL
    return c.json({ version_hash, context });
  }
);

// GET /v1/scopes/:id
app.get('/v1/scopes/:id', async (c) => {
  const scopeId = c.req.param('id');
  if (!UUID_V4.test(scopeId)) return c.json({ error: 'invalid scope_id' }, 400);
  // ... read scope state
  return c.json({ scope_id, status, context });
});

// Start server
export default { port: 3000, fetch: app.fetch };
```

**Note:** `@hono/zod-validator` is a separate package. Install: `npm install @hono/zod-validator`. [ASSUMED — verify `npm view @hono/zod-validator version` before implementing]

---

### Pattern 4: pgcrypto Writable CTE — OCC Atomic Causal Inversion

**What:** Single SQL statement that atomically writes `memory_updated` or `conflict_detected` with SHA-256 hash. Application sends pre-serialized `canonical_json_text` as TEXT — PostgreSQL NEVER does `::jsonb` conversion.
**When to use:** Every Worker write path. The canonical OCC gate.

```sql
-- Source: [CITED: postgresql.org/docs/current/pgcrypto.html]
-- [CITED: postgresql.org/docs/current/sql-insert.html — ON CONFLICT DO UPDATE]
-- canonical_json_text = $4 (TEXT) — computed in TypeScript BEFORE this call
-- PostgreSQL receives it as TEXT literal — never ::jsonb

WITH attempt AS (
  INSERT INTO execution_event_log (
    scope_id, entity_id, event_type, predecessor_hash,
    version_hash, payload, created_at
  )
  VALUES (
    $1::uuid,          -- scope_id
    $2::uuid,          -- entity_id
    'memory_updated',
    $3::text,          -- predecessor_hash (the slot we claim)
    encode(
      digest(
        $1::text || '|' || $2::text || '|' || $3::text
            || '|memory_updated|' || $4::text,
        'sha256'
      ),
      'hex'
    ),
    $4::text,          -- store canonical_json_text as text (NOT ::jsonb — ADR 02)
    NOW()
  )
  ON CONFLICT ON CONSTRAINT uk_scope_composite_occ_{scope_partition_id}
  (predecessor_hash, scope_id) DO UPDATE SET
    event_type = 'conflict_detected',
    -- Causal inversion: predecessor_hash forced to point to winner's version_hash
    predecessor_hash = (
      SELECT version_hash FROM execution_event_log
      WHERE predecessor_hash = $3::text AND scope_id = $1::uuid
        AND event_type = 'memory_updated'
      ORDER BY created_at DESC LIMIT 1
    ),
    version_hash = encode(
      digest(
        $1::text || '|' || $2::text
          || '|' || (
            SELECT version_hash FROM execution_event_log
            WHERE predecessor_hash = $3::text AND scope_id = $1::uuid
              AND event_type = 'memory_updated'
            ORDER BY created_at DESC LIMIT 1
          )
          || '|conflict_detected|' || $4::text,
        'sha256'
      ),
      'hex'
    ),
    payload = $4::text,
    created_at = NOW()
  RETURNING event_type, version_hash
)
SELECT event_type, version_hash,
  CASE event_type
    WHEN 'memory_updated'   THEN 'won'
    WHEN 'conflict_detected' THEN 'demoted'
  END AS occ_result
FROM attempt;
```

**TypeScript call site:**
```typescript
// Source: ADR 02 corrected implementation [CITED: docs/ADR_v4.md §ADR 02]
import { canonicalJson, hashablePayload } from '@/shared/canonical-json';

const canonicalText = hashablePayload(payload); // strips _meta + schema_version, sorts keys

const result = await pool.query(occWriteSQL, [
  scopeId,
  entityId,
  predecessorHash,
  canonicalText,   // TEXT literal — PostgreSQL uses it directly
]);

const { occ_result, version_hash } = result.rows[0];
// occ_result: 'won' | 'demoted'
```

---

### Pattern 5: FOR UPDATE SKIP LOCKED — PgQueueAdapter

**What:** Atomic event claim from `execution_event_log` that prevents two Workers from processing the same event.
**When to use:** PgQueueAdapter.nextEvent() implementation. Do NOT use in other paths.

```typescript
// Source: ADR 32 D-4 [CITED: docs/adr/0034-adr32-pgqueueadapter-and-idempotency.md]
// [CITED: postgresql.org/docs/current/sql-select.html — FOR UPDATE SKIP LOCKED]

class PgQueueAdapter implements IQueueAdapter {
  async nextEvent(scopeId: string): Promise<EventLogNode | null> {
    const result = await this.pool.query(
      `UPDATE execution_event_log
       SET status = 'processing', dispatched_at = NOW()
       WHERE id = (
         SELECT id FROM execution_event_log
         WHERE status = 'pending_dispatch' AND scope_id = $1
         ORDER BY event_id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, event_type, entity_id, payload, predecessor_hash`,
      [scopeId]
    );
    return result.rows[0] ?? null;
  }
}

// LISTEN/NOTIFY wakeup (no data in payload — wakeup signal only per ADR 09)
await this.pgClient.query('LISTEN graph_event_ready');
this.pgClient.on('notification', async () => {
  if (this.activeWorkerCount >= MAX_PARALLELISM) return;  // backpressure
  const event = await this.nextEvent(scopeId);
  if (event) await this.dispatchToWorker(event);
});
```

**Important:** `this.pgClient` must be a dedicated non-pooled client for LISTEN — `Pool` clients cannot maintain LISTEN state between pool checkouts. [ASSUMED — standard node-postgres constraint]

---

### Pattern 6: @dqbd/tiktoken Wasm Tokenizer (exact load pattern)

**What:** Load the Wasm tokenizer and count tokens. Must call `get_encoding()` once and reuse.
**When to use:** W_max budget calculation in Knapsack Slicing and Context Assembly.

```typescript
// Source: [CITED: TECH_STACK.md §3, github.com/dqbd/tiktoken]
// Note: TECH_STACK.md documents get_encoding(), not encoding_for_model()
// get_encoding() takes an encoding name; encoding_for_model() takes a model name
import { get_encoding } from '@dqbd/tiktoken';

// Initialize ONCE at module level — Wasm initialization has startup cost
// cl100k_base: GPT-4, GPT-3.5, Claude (approximate)
// o200k_base: GPT-4o
const enc = get_encoding('cl100k_base');

export function countTokens(text: string): number {
  return enc.encode(text).length;
}

// IMPORTANT: Call enc.free() on process exit to release Wasm memory
process.on('exit', () => enc.free());
```

**Initialization hazard:** The Wasm binary is loaded synchronously on first `get_encoding()` call. In Node.js this is safe but adds ~100ms startup latency on first call. Initialize at module load time, not inside hot paths. [CITED: github.com/dqbd/tiktoken README]

---

### Pattern 7: TypeScript ABC Boundary (ADR 35 — exact implementation)

**What:** Compile-time + runtime enforcement that Tool classes cannot call `graph.write()`.
**When to use:** All Worker and Tool definitions in `packages/workers/`.

```typescript
// Source: [CITED: docs/adr/0037-adr35-worker-tool-boundary-enforcement.md]

// === GRAPH HANDLE (Workers get this) ===
interface GraphHandle {
  write(event: GraphWriteEvent): Promise<WriteResult>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

// === READ-ONLY HANDLE (Tools get this — write() ABSENT from interface) ===
interface ReadOnlyGraphHandle {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  // write() is NOT declared — TypeScript error if Tool attempts ctx.graph.write()
}

// === WORKER ABSTRACT BASE CLASS ===
abstract class Worker {
  abstract onScheduled(ctx: WorkerExecutionContext): Promise<void>;
  abstract onRunning(ctx: WorkerExecutionContext): Promise<WorkerResult>;
  abstract onCompleted(ctx: WorkerExecutionContext): Promise<void>;
  abstract onFailed(ctx: WorkerExecutionContext, error: Error): Promise<void>;
  abstract onConflicted(ctx: WorkerExecutionContext): Promise<void>;
}
interface WorkerExecutionContext {
  scopeId: string;
  entityId: string;
  currentVersionHash: string;
  graph: GraphHandle;   // write() IS present
  input: unknown;
}

// === TOOL INTERFACE ===
interface Tool<TInput extends z.ZodType, TOutput extends z.ZodType> {
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  execute(input: z.infer<TInput>, ctx: ToolExecutionContext): Promise<z.infer<TOutput>>;
}
interface ToolExecutionContext {
  graph: ReadOnlyGraphHandle;  // write() ABSENT — TypeScript error at compile time
}

// === RUNTIME GUARD ===
class ReadOnlyGraphHandleImpl implements ReadOnlyGraphHandle {
  constructor(private pool: Pool, private scopeId: string) {}

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    return this.pool.query(sql, params).then(r => r.rows as T[]);
  }

  // Not on interface — only exists to catch runtime `any` bypasses
  write(_event: unknown): never {
    throw new SecurityException(
      'Tool attempted graph write — capability does not exist in Tool context. ' +
      'Register as Worker with graph:: prefix if write access is required.'
    );
  }
}

// === REGISTRATION — compile-time enforced signatures ===
sdk.registerWorker('graph::conflict-resolver', new ConflictResolverWorker());
sdk.registerTool('tool::tokenize', tokenizeTool);
```

---

### Pattern 8: iii-config.yaml — Complete Phase 1 Configuration

```yaml
# iii-config.yaml — Phase 1 configuration
# Source: [CITED: github.com/iii-hq/iii, TECH_STACK.md §1, iii.dev/docs/how-to/configure-engine]
port: ${III_PORT:49134}

workers:
  # Required: iii Worker Manager (SDK bridge)
  - name: iii-worker-manager
    config:
      port: 49134

  # HTTP API (iii's own REST — separate from our Hono Gateway)
  - name: iii-http
    config:
      port: 3111

  # Cron scheduler — 7-field format: sec min hr day month weekday year
  - name: iii-cron
    config:
      adapter:
        name: kv

  # Observability
  - name: iii-observability
    config:
      enabled: true
      exporter: memory
      logs_enabled: true

  # Spawn our TypeScript workers/control-plane process
  - name: iii-exec
    config:
      exec:
        # Cross-platform safe: use node directly, not shell scripts
        - node dist/control-plane/index.js
        - node dist/workers/index.js
        # Gateway runs separately: node dist/gateway/index.js

# LLM Provider (ADR 22 — OpenAI-compatible REST)
# Credentials live here ONLY — Workers never hold credentials directly
llm:
  provider: openai_compatible
  base_url: ${LLM_BASE_URL:http://localhost:11434/v1}
  model: ${LLM_MODEL:llama3.2}
  api_key: ${LLM_API_KEY:""}

embedding:
  provider: openai_compatible
  base_url: ${EMBEDDING_BASE_URL:http://localhost:11434/v1}
  model: ${EMBEDDING_MODEL:nomic-embed-text}
  dimensions: 1536
  api_key: ${EMBEDDING_API_KEY:""}
```

**Cron schedule examples (7-field format):**
- Every 6 hours: `0 0 */6 * * * *`
- Every day at 2 AM: `0 0 2 * * * *`
- Every day at 3 AM: `0 0 3 * * * *`

[CITED: github.com/iii-hq/iii iii-cron worker docs — 7-field format confirmed in deep-cross-validation-round2.md]

---

### Pattern 9: canonical_json — Corrected TypeScript Implementation

```typescript
// Source: [CITED: docs/ADR_v4.md §ADR 02 — corrected 2026-05-31]
// WARNING: The version in TECH_STACK.md §2.5 has a double-encoding bug for arrays.
// Use ONLY the version from ADR_v4.md §ADR 02:

// sortedValue walks the tree and returns a JS value (not a string)
function sortedValue(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(sortedValue);
  if (payload && typeof payload === 'object') {
    return Object.fromEntries(
      Object.keys(payload as object).sort()
        .map(k => [k, sortedValue((payload as Record<string, unknown>)[k])])
    );
  }
  return payload;
}

// JSON.stringify runs exactly ONCE on the fully-sorted tree
export function canonicalJson(payload: unknown): string {
  return JSON.stringify(sortedValue(payload));
}

// Strip _meta and schema_version before computing hash
export function hashablePayload(payload: Record<string, unknown>): string {
  const { _meta, schema_version, ...rest } = payload;
  return canonicalJson(rest);
}
```

**Bug in old version (do NOT use):**
```typescript
// BROKEN: Arrays are double-encoded — payload.map(canonicalJson) returns string[]
// JSON.stringify then wraps each string in quotes, producing ["\"a\"","\"b\""] not ["a","b"]
// This causes hash mismatch between Rust and TypeScript implementations
function canonicalJson(payload: unknown): string {
  if (Array.isArray(payload)) return JSON.stringify(payload.map(canonicalJson)); // BUG
  ...
}
```

---

### Anti-Patterns to Avoid

- **Using `jsonb::text` in PostgreSQL for hash input:** PostgreSQL `jsonb` uses length-first key ordering internally — NOT alphabetical. `jsonb::text` produces different key ordering than TypeScript `Object.keys().sort()`. Always send pre-serialized `canonical_json_text` as a TEXT parameter. [CITED: docs/ADR_v4.md §ADR 02 refutation]

- **Initializing tiktoken inside hot paths:** `get_encoding()` loads the Wasm binary (~100ms). Call it once at module init. Calling it on every token count request causes measurable latency spikes.

- **Using a Pool client for LISTEN/NOTIFY:** pg Pool clients are checked in/out per query. LISTEN state is connection-specific. Use a dedicated `new Client()` (not Pool) for the pg-listen subscriber, or let pg-listen manage its own client (it does this automatically). [ASSUMED — standard node-postgres behavior]

- **Passing event data in pg_notify payload:** ADR 09 specifies ≤64B pulse (event ID only). The full event is fetched via point-query. Putting event data in the payload risks the 8000-byte PostgreSQL limit and breaks the HWM-based replay design. [CITED: postgresql.org/docs/current/sql-notify.html]

- **Writing to the graph during Worker Processing phase:** ADR 27 iron rule — no persistent writes during Processing. All graph writes happen in the Writing phase. Intermediate LLM results stay in memory only.

- **Using `sdk.registerFunction` for external agent submissions:** External agents (Claude Code, etc.) are External Participants that submit events via HTTP Gateway. They do NOT register as Workers. [CITED: ADR 24, CONTEXT.md]

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BPE token counting | JS-based BPE tokenizer | `@dqbd/tiktoken` | Pure JS implementations have boundary-byte inaccuracies that cause W_max violations at critical context sizes |
| PostgreSQL LISTEN/NOTIFY with reconnect | Raw `pg.Client.on('notification')` loop | `pg-listen` | pg-listen handles reconnect, channel management, error recovery; raw client requires complex retry logic |
| SHA-256 hash computation | Node.js `crypto.createHash()` | `pgcrypto.digest()` inside Writable CTE | Hash MUST be computed in the same DB transaction as the INSERT for atomic causal inversion; out-of-DB hash enables race conditions |
| HTTP request validation | Manual type checking | Zod + `@hono/zod-validator` | Manual checks miss edge cases in UUID format (v4 variant bits) and hex length; Zod provides structural validation |
| Worker event dispatch | Custom WebSocket server | `iii-sdk` + iii Engine | iii Engine provides at-least-once delivery, reconnect, function routing, cron — rebuilding these takes weeks |
| Priority queue | In-memory heap | PostgreSQL `FOR UPDATE SKIP LOCKED` + priority SQL | Database-backed queue is durable across crashes; heap loses pending events on restart |
| Canonical JSON | `JSON.stringify()` | `sortedValue()` + `JSON.stringify()` (once) | `JSON.stringify` does not guarantee key order; any hash built on it is non-deterministic across V8 versions |

**Key insight:** The hash chain is the system's integrity foundation. Any component in the hash pipeline (canonical JSON, pgcrypto call site, predecessor_hash threading) that deviates from the exact specification creates cryptographically inconsistent chains that corrupt OCC semantics permanently.

---

## Common Pitfalls

### Pitfall 1: TECH_STACK.md canonicalJson Has Array Double-Encoding Bug

**What goes wrong:** The `canonicalJson` implementation in `docs/TECH_STACK.md §2.5` calls `payload.map(canonicalJson)` which returns `string[]`. `JSON.stringify` then wraps each string in quotes, producing `["\"a\"","\"b\""]` instead of `["a","b"]`. Arrays with object elements become doubly JSON-encoded strings.

**Why it happens:** `canonicalJson` was designed to return a `string`, so `map(canonicalJson)` maps each array element to its string JSON representation, then `JSON.stringify` serializes the string array as if strings were values.

**How to avoid:** Use the corrected two-function form from ADR_v4.md §ADR 02: `sortedValue()` returns a JS value tree; `canonicalJson()` calls `JSON.stringify` exactly once on the sorted tree.

**Warning signs:** Hash mismatches between TypeScript and any Rust implementation; test that `canonicalJson([{ b: 1, a: 2 }])` returns `[{"a":2,"b":1}]` not `["[{\"a\":2,\"b\":1}]"]`.

---

### Pitfall 2: pg-listen API — `.notifications.on()` not `client.on('notification')`

**What goes wrong:** Developers familiar with raw node-postgres write `subscriber.on('notification', cb)` or `pool.on('notification', cb)`. Neither works — pg-listen exposes `.notifications` (an EventEmitter) and `.events` (for error/reconnect).

**Why it happens:** Node-postgres Pool has no `.on('notification')` because Pool clients are checked in/out per query. pg-listen wraps a dedicated client.

**How to avoid:** Always use `subscriber.notifications.on(channelName, cb)`. The channel name argument MUST match exactly what was passed to `subscriber.listenTo(channelName)`.

**Warning signs:** No notifications arriving even though pg_notify fires (check with `LISTEN graph_events; SELECT pg_notify('graph_events', '{}');` in psql directly).

---

### Pitfall 3: Boot Order — pg-listen Must LISTEN Before Reading HWM

**What goes wrong:** If the Control Plane reads the HWM from `bus_state` before the `LISTEN` command commits, events inserted in the window between reading HWM and LISTEN activation are missed. After reconnect, the replay query starts from the stale HWM and misses those events.

**Why it happens:** LISTEN takes effect at commit of the LISTEN command. Events inserted before LISTEN commits but after HWM was read are in a gap.

**How to avoid:** The correct boot sequence is: (1) `await subscriber.connect()`, (2) `await subscriber.listenTo(channel)`, (3) read current HWM, (4) replay missed events since HWM. Only after step 4 is the system in a consistent state. [CITED: postgresql.org/docs/current/sql-listen.html]

**Warning signs:** Occasional missing events after process restart (not reproducible under low load, only under concurrent writes at startup).

---

### Pitfall 4: @dqbd/tiktoken Wasm Memory Management

**What goes wrong:** `enc.encode(text)` returns a `Uint32Array` backed by Wasm memory. In long-running processes without calling `enc.free()` on shutdown, Wasm heap grows. More critically, calling `get_encoding()` multiple times creates multiple Wasm instances (no singleton by default).

**Why it happens:** Wasm memory is not garbage collected by the V8 GC.

**How to avoid:** Call `get_encoding()` once at module initialization. Register `process.on('exit', () => enc.free())`. Do not create an encoding per request. [CITED: github.com/dqbd/tiktoken README]

**Warning signs:** Growing Node.js RSS memory in long-running processes; ENOMEM errors in worker processes under load.

---

### Pitfall 5: OCC constraint name must match partition

**What goes wrong:** The OCC constraint (`uk_scope_composite_occ_{id}`) is created per-partition in the 3-phase DDL nesting protocol. The Writable CTE uses `ON CONFLICT ON CONSTRAINT <name>`. If the constraint name does not exactly match the partition's constraint name, PostgreSQL falls through to a generic `ON CONFLICT (predecessor_hash, scope_id)` — which may not exist on the partition, causing the whole INSERT to fail with a unique violation exception instead of triggering the DO UPDATE path.

**Why it happens:** Partitioned tables in PostgreSQL require constraints on the partition level, not the parent table level. The `ON CONFLICT ON CONSTRAINT` clause in the CTE must reference the partition's constraint.

**How to avoid:** Use `ON CONFLICT (predecessor_hash, scope_id) DO UPDATE` (column list form) instead of `ON CONFLICT ON CONSTRAINT <name>`. The column list form resolves to the correct partition-level constraint automatically. [CITED: postgresql.org/docs/current/sql-insert.html — ON CONFLICT column list vs. constraint name]

**Warning signs:** `ERROR: there is no unique or exclusion constraint matching the ON CONFLICT specification` on writes to non-default partitions.

---

### Pitfall 6: iii-exec Windows Cross-Platform

**What goes wrong:** On Windows, `iii-exec` wraps commands with `cmd /C` instead of `sh -c`. Shell-specific syntax (`NODE_ENV=production node ...`) fails silently on Windows.

**How to avoid:** Use cross-platform safe exec commands in `iii-config.yaml` — call `node` directly without shell variable injection. Use `cross-env` or `.env` files for environment variables. [CITED: iii.dev/docs/how-to/configure-engine — Windows behavior documented in iii-engine.md]

**Warning signs:** Workers fail to start on Windows; iii-exec reports exit code 1 immediately.

---

## Code Examples

### pgvector HNSW Index DDL (procedural_memory topology_embedding)

```sql
-- Source: [CITED: github.com/pgvector/pgvector README — m=16, ef_construction=64 are defaults]
-- Phase 1 stub: topology_embedding vector(128) for WL kernel Phase 3

CREATE TABLE procedural_memory (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_id        UUID REFERENCES scope_lineage(scope_id),
  intent_description TEXT NOT NULL,
  template_graph  JSONB,
  quality_score   FLOAT DEFAULT 0.5,
  is_anti_pattern BOOLEAN DEFAULT FALSE,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  ts_doc          TSVECTOR GENERATED ALWAYS AS (
                    to_tsvector('simple', coalesce(intent_description, ''))
                  ) STORED,
  topology_embedding vector(128)  -- Phase 3 WL kernel stub
);

-- HNSW index for topology_embedding (Phase 3 stub — created in Phase 1 DDL)
CREATE INDEX idx_procedural_topology_hnsw
ON procedural_memory
USING hnsw (topology_embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64)
WHERE is_anti_pattern = FALSE;

-- GIN index for BM25 full-text search (Phase 2 retrieval)
CREATE INDEX idx_procedural_ts_doc_gin
ON procedural_memory USING GIN (ts_doc);
```

### Scope Partition DDL (3-phase nesting, Phase 1 of protocol)

```sql
-- Source: [CITED: docs/ADR_v4.md §ADR 04]
-- Executed in DDL exclusive connection, single transaction

-- Phase 1: Create partition sub-table
CREATE TABLE execution_event_log_scope_{scope_uuid_nodash}
PARTITION OF execution_event_log
FOR VALUES IN ('{scope_uuid}');

-- Phase 1: OCC hard-stop constraint (one per partition)
ALTER TABLE execution_event_log_scope_{scope_uuid_nodash}
ADD CONSTRAINT uk_scope_composite_occ_{scope_uuid_nodash}
UNIQUE (predecessor_hash, scope_id);

-- Phase 1: Composite lookup index (ADR 13, ADR 19)
CREATE INDEX idx_scope_{scope_uuid_nodash}_pending_lookup
ON execution_event_log_scope_{scope_uuid_nodash} (scope_id, status, event_id ASC)
WHERE status IN ('pending_scheduling', 'pending_dispatch');
```

### Convergence Watchdog SQL (3rd tier B-Tree terminal check)

```sql
-- Source: [CITED: docs/ADR_v4.md §ADR 19]
-- Returns true if scope has converged (safe to emit scope_closed)

SELECT NOT EXISTS (
  SELECT 1 FROM execution_event_log
  WHERE scope_id = $1
    AND status NOT IN ('terminated', 'archived')
    AND event_type NOT IN ('scope_closed', 'conflict_detected')
) AS is_converged,
NOT EXISTS (
  SELECT 1 FROM execution_event_log
  WHERE scope_id = $1
    AND event_type = 'conflict_detected'
    AND status != 'resolved'
) AS no_open_conflicts;
-- is_converged AND no_open_conflicts → safe to INSERT scope_closed
```

### Frontier Scheduler Priority SQL (ADR 31 five-term formula)

```sql
-- Source: [CITED: docs/adr/0033-adr31-frontier-scheduler-architecture.md]
-- Five-term formula per REQ-19: base×10 + age_bonus(≤20) + unlocks×5 + spawned_by_bonus(3) + active_bonus(15)
-- NOTE: base_priority, unlocks_count, spawned_by, last_active_at are typed columns in execution_event_log
-- (NOT payload->>'...' JSONB operators — payload column is TEXT per ADR 02 invariant)
-- These typed columns are added alongside payload TEXT in migrations/002-event-log.sql:
--   base_priority INT NOT NULL DEFAULT 1
--   unlocks_count INT NOT NULL DEFAULT 0
--   spawned_by UUID NULL  (set when task is spawned by a parent scope)
--   last_active_at TIMESTAMPTZ NULL  (updated by Control Plane on Worker heartbeat)
WITH frontier_nodes AS (
  SELECT
    id, entity_id, event_type, created_at,
    base_priority,
    unlocks_count,
    spawned_by,
    last_active_at,
    LEAST(EXTRACT(EPOCH FROM (NOW() - created_at)) * 10, 20) AS age_bonus
  FROM execution_event_log
  WHERE status = 'pending_scheduling' AND scope_id = $1
)
SELECT id, entity_id,
  (base_priority * 10 + age_bonus + unlocks_count * 5
   + CASE WHEN spawned_by IS NOT NULL THEN 3 ELSE 0 END
   + CASE WHEN last_active_at > NOW() - INTERVAL '5 seconds' THEN 15 ELSE 0 END
  ) AS dynamic_score
FROM frontier_nodes
ORDER BY dynamic_score DESC, created_at ASC
LIMIT $2;  -- Max_Parallelism_remaining
```

---

## State of the Art

| Old Approach | Current Approach | Changed | Impact |
|--------------|------------------|---------|--------|
| `jsonb::text` for canonical JSON | Application-layer BTreeMap sort | 2026-05-31 (ADR 02 P0-D fix) | `jsonb` uses length-first key order internally — not alphabetical; PostgreSQL spec does not guarantee `jsonb::text` key order |
| `Client.notifications()` in tokio-postgres | `Connection::poll_message()` + stream | Confirmed 2026-05-31 | `notifications()` method does not exist; `poll_message` is the correct API for async notification handling |
| `pg_bm25` extension name | `pg_search` (ParadeDB) | Renamed at v0.6.0 | `pg_bm25` is the old name — install `pg_search` instead if upgrading to true BM25 in Phase 2 |
| `hnsw.iterative_scan` Phase 1 | Deferred to Phase 3 | pgvector 0.8.0 | Phase 1 uses CTE pre-filter (exact scan within scope partition) — acceptable for Phase 1 scope sizes |

**Deprecated/outdated:**
- `canonicalJson` from TECH_STACK.md §2.5: array double-encoding bug — use ADR_v4.md §ADR 02 version
- `encoding_for_model()` from CONTEXT.md §Specifics: TECH_STACK.md uses `get_encoding('cl100k_base')` which is the correct Node.js pattern; `encoding_for_model()` is also valid but requires model name string
- `ON CONFLICT ON CONSTRAINT <name>` form: prefer column list form `ON CONFLICT (predecessor_hash, scope_id)` for partition compatibility

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `@hono/zod-validator` is the correct package name for Hono's Zod middleware | Pattern 3 | Package may be bundled differently in Hono v4; verify with `npm view @hono/zod-validator` |
| A2 | A dedicated `new Client()` (not Pool) is required for LISTEN connections in node-postgres | Pattern 5 | If Pool supports LISTEN via reserved connection, implementation can simplify |
| A3 | `iii.trigger()` on the SDK object returned by `registerWorker()` is the correct programmatic dispatch API | Pattern 1 | The trigger method may have a different signature in iii-sdk 0.17.0; verify against iii-sdk source |
| A4 | `payload::text` stores canonical_json_text in execution_event_log correctly as TEXT (not JSONB) | Pattern 4 | Column type definition matters — column must be TEXT not JSONB for this to work correctly |
| A5 | Windows `cmd /C` behavior for iii-exec is the current documented behavior | Pitfall 6 | iii may have changed exec behavior on Windows in 0.16.x+ |

---

## Open Questions (RESOLVED)

1. **@hono/zod-validator package name in Hono v4** — RESOLVED
   - Resolution: `@hono/zod-validator@0.8.0` IS the correct separate package for Hono v4. Confirmed via npm registry: the package exists and is the standard integration point. Import via `import { zValidator } from '@hono/zod-validator'`. The built-in `hono/validator` is a lower-level primitive; `@hono/zod-validator` wraps it with schema inference. Plan 07 Task 1 uses `@hono/zod-validator@0.8.0` — this is authoritative.

2. **`execution_event_log` column type for payload storage** — RESOLVED
   - Resolution: `payload TEXT NOT NULL`. ADR 02 invariant explicitly forbids `::jsonb` conversion; TEXT enforces this at the column level. Plan 02 Task 1 `must_haves.truths` confirms "execution_event_log payload column is TEXT (never JSONB) per ADR 02". No ambiguity remains. Note: frontier priority columns (`base_priority`, `unlocks_count`, `spawned_by`, `last_active_at`) are stored as typed columns alongside `payload TEXT` — see updated Frontier SQL below.

3. **iii-sdk `trigger()` method return type and async semantics** — RESOLVED
   - Resolution: `iii.trigger(workerType, payload)` is **fire-and-forget** — it returns `void` (or `Promise<void>` that resolves on enqueue acknowledgment, not on Worker completion). Confirmed by iii-sdk 0.17.0 TypeScript typings and `.harness/research/iii-engine.md`. The Pulse-Fetch bridge in Plan 04 calls `iii.trigger()` without awaiting a function result — the Worker result is written back to the execution graph via `GraphHandle.write()`, not returned through `trigger()`.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All TypeScript packages | ✓ (assumed) | v20 LTS recommended | — |
| PostgreSQL | SSOT storage | Verify before Phase 1 | 15+ required | Docker `pgvector/pgvector:pg16` |
| pgcrypto extension | Hash chain (REQ-02) | Verify with `SELECT * FROM pg_extension WHERE extname='pgcrypto'` | contrib built-in | `CREATE EXTENSION IF NOT EXISTS pgcrypto;` in migration |
| pgvector extension | HNSW indexes (REQ-04) | Verify with `SELECT * FROM pg_extension WHERE extname='vector'` | 0.7.0+ | Docker image includes it |
| iii binary | Event routing | Verify with `iii --version` | 0.16.x (match SDK minor) | Install: `curl -fsSL https://install.iii.dev/iii/main/install.sh | sh` |
| ollama (or other LLM) | LLM/embedding calls (REQ-21) | Verify with `curl localhost:11434/v1/models` | Any OpenAI-compatible | Use OpenAI API key as fallback |

**Missing dependencies with no fallback:**
- PostgreSQL 15+ is a hard requirement — all schema features depend on PARTITION BY LIST, GENERATED ALWAYS, and pgcrypto
- iii binary must be version-compatible with iii-sdk (same minor version line per iii versioning policy)

**Missing dependencies with fallback:**
- Local LLM (ollama/llama.cpp): use OpenAI API with environment variable override

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (recommended) or Jest |
| Config file | `vitest.config.ts` — Wave 0 gap |
| Quick run command | `npx vitest run --reporter=dot` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-02 | pgcrypto digest() produces correct hex hash | integration | `vitest run tests/hash-chain.test.ts` | Wave 0 |
| REQ-03 | canonicalJson produces deterministic output regardless of insertion order | unit | `vitest run tests/canonical-json.test.ts` | Wave 0 |
| REQ-03 | canonicalJson array elements are not double-encoded | unit | `vitest run tests/canonical-json.test.ts` | Wave 0 |
| REQ-11 | Tool compile error when calling ctx.graph.write() | compile-time | `tsc --noEmit` (CI check) | Wave 0 |
| REQ-11 | ReadOnlyGraphHandleImpl.write() throws SecurityException | unit | `vitest run tests/abc-boundary.test.ts` | Wave 0 |
| REQ-15 | POST /v1/scopes returns 400 on invalid UUID | integration | `vitest run tests/gateway.test.ts` | Wave 0 |
| REQ-15 | POST /v1/scopes/:id/events returns 400 on invalid hash | integration | `vitest run tests/gateway.test.ts` | Wave 0 |
| REQ-17 | PgQueueAdapter.nextEvent() claims one row with SKIP LOCKED | integration | `vitest run tests/queue-adapter.test.ts` | Wave 0 |
| REQ-18 | ON CONFLICT DO NOTHING silently drops duplicate version_hash | integration | `vitest run tests/idempotency.test.ts` | Wave 0 |
| REQ-19 | Frontier score formula produces correct dynamic_score values | unit | `vitest run tests/frontier-scheduler.test.ts` | Wave 0 |
| REQ-20 | Overflow discarder fills newest events first, stops at budget | unit | `vitest run tests/context-assembly.test.ts` | Wave 0 |

### Sampling Rate

- **Per task commit:** `npx vitest run tests/canonical-json.test.ts tests/abc-boundary.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `tests/canonical-json.test.ts` — covers REQ-03 (determinism + array encoding)
- [ ] `tests/hash-chain.test.ts` — covers REQ-02 (pgcrypto integration)
- [ ] `tests/abc-boundary.test.ts` — covers REQ-11 (compile + runtime SecurityException)
- [ ] `tests/gateway.test.ts` — covers REQ-15, REQ-16 (Zod 400 paths)
- [ ] `tests/queue-adapter.test.ts` — covers REQ-17 (SKIP LOCKED)
- [ ] `tests/idempotency.test.ts` — covers REQ-18 (DO NOTHING)
- [ ] `tests/frontier-scheduler.test.ts` — covers REQ-19 (priority formula)
- [ ] `tests/context-assembly.test.ts` — covers REQ-20 (overflow discard)
- [ ] `vitest.config.ts` — shared test configuration
- [ ] `tests/helpers/pg-test-pool.ts` — shared test database pool fixture

---

## Sources

### Primary (HIGH confidence)

- `docs/ADR_v4.md` — ADR 01-12, canonicalJson corrected implementation, hash matrix
- `docs/adr/0026-adr24-agent-entry-point-protocol.md` — HTTP Gateway spec, Zod regexes
- `docs/adr/0029-adr27-worker-lifecycle-state-machine.md` — 4-phase lifecycle, Knapsack failure bifurcation
- `docs/adr/0032-adr30-context-assembly-strategy.md` — 3-layer prompt, IOverflowStrategy
- `docs/adr/0033-adr31-frontier-scheduler-architecture.md` — token bucket, priority SQL
- `docs/adr/0034-adr32-pgqueueadapter-and-idempotency.md` — FOR UPDATE SKIP LOCKED, IQueueAdapter
- `docs/adr/0037-adr35-worker-tool-boundary-enforcement.md` — TypeScript ABC full implementation
- `.harness/research/iii-engine.md` — iii-sdk API surface (registerWorker, registerFunction, cron format)
- `.harness/research/tech.md` — pg-listen API, pgcrypto patterns, pgvector HNSW DDL
- `.harness/research/verify-pgvector.md` — HNSW partial index VERIFIED, m=16 ef_construction=64 defaults
- `.harness/research/deep-cross-validation-round2.md` — pg-listen API clarification, cron 7-field format
- `docs/TECH_STACK.md` — @dqbd/tiktoken 2-line pattern, iii-config.yaml structure
- `docs/ARCHITECTURE.md` — component diagram, permission boundary table

### Secondary (MEDIUM confidence)

- `npm view pg version` → 8.21.0 (verified 2026-06-02)
- `npm view pg-listen version` → 1.7.0 (verified 2026-06-02)
- `npm view iii-sdk version` → 0.17.0 (verified 2026-06-02)
- `npm view @dqbd/tiktoken version` → 1.0.22 (verified 2026-06-02)
- `npm view hono version` → 4.12.23 (verified 2026-06-02)
- `npm view zod version` → 4.4.3 (verified 2026-06-02)

### Tertiary (LOW confidence / ASSUMED)

- `@hono/zod-validator` package name in Hono v4 (A1) — verify before implementation
- `iii.trigger()` async return semantics (A3) — verify against iii-sdk typings

---

## Metadata

**Confidence breakdown:**

- Standard stack: HIGH — all packages verified on npm; iii-sdk API verified against official iii docs via Context7
- Architecture: HIGH — 37 locked ADRs + architecture doc + research reports form complete spec
- Pitfalls: HIGH — all pitfalls derived from verified research (ADR corrections, Context7 pg-listen API, PostgreSQL official docs)
- canonicalJson bug: HIGH — bug confirmed in ADR 02 errata (2026-05-31 correction)
- pg-listen API: HIGH — confirmed via deep-cross-validation-round2.md and iii-engine.md research
- @hono/zod-validator: MEDIUM — package assumed; verify before Wave 0

**Research date:** 2026-06-02
**Valid until:** 2026-07-02 (iii SDK is fast-moving; re-verify iii-sdk API surface if > 30 days)
