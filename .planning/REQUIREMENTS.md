# Requirements: Graph-Native Agent Runtime

> Derived from 37 locked ADRs (ADR 01–37) and Phase 1 implementation decisions (D-1 through D-10).
> All requirements below are Phase 1 scope. ADR references are authoritative — read the linked docs before implementing.

## Phase 1: Core Graph Engine

### PostgreSQL Schema & Hash Chain

**REQ-01**: Implement `execution_event_log` as a PostgreSQL PARTITION BY LIST on `scope_id` append-only table. Each partition is a scope sub-table. Include `UNIQUE(predecessor_hash, scope_id)` OCC hard-stop constraint. Derive from ADR 01–12 schema spec in `docs/ADR_v4.md`.

**REQ-02**: All version_hash computation MUST use PostgreSQL `pgcrypto` `digest()` function inside a Writable CTE. Hash formula: `digest(scope_id || '|' || entity_id || '|' || predecessor_hash || '|' || event_type || '|' || canonical_json_text, 'sha256')`. Application layer provides pre-serialized `canonical_json_text` (TEXT). PostgreSQL side MUST NOT do `::jsonb` conversion. Ref: ADR 02 P0-D fix, `docs/ADR_v4.md` §ADR 02.

**REQ-03**: `canonical_json` serialization MUST be implemented in TypeScript via recursive `BTreeMap`-equivalent (`Object.keys().sort()`) ensuring deterministic key order regardless of insertion order. Ref: ADR 02 P0-D correction.

**REQ-04**: Schema includes four memory tables: `episodic_memory`, `semantic_memory`, `procedural_memory`, `working_memory`. Each gets: `ts_doc tsvector GENERATED ALWAYS AS (to_tsvector('english', content))` for BM25 Phase 2 prep. `procedural_memory` includes `topology_embedding vector(128)` column with HNSW index `m=16, ef_construction=64` (Phase 3 stub). Ref: ADR 20, ADR 25.

**REQ-05**: `scope_lineage` cold metadata table (not append-only event log). Written atomically during the 3-phase DDL nesting protocol. Ref: ADR 23, ADR 05.

### Control Plane Daemon

**REQ-06**: Control Plane Daemon is a TypeScript process connecting to PostgreSQL via `pg-listen` for LISTEN/NOTIFY. On notification: advance High Water Mark in `bus_state`, call `iii.trigger(worker_type, event_payload)`. Exclusive DDL connection pool separate from event read connection. Ref: `docs/ARCHITECTURE.md` §Control Plane.

**REQ-07**: 3-phase Scope nesting protocol (ADR 05): Phase 1 = DDL exclusive connection creates partition sub-table + HNSW index; Phase 2 = writes `scope_lineage` record; Phase 3 = fires first `plan_created` event. All three phases within a single DDL transaction. Ref: ADR 05.

**REQ-08**: Topological Convergence Watchdog (ADR 19): 3-tier defense — in-memory atomic counter → conflict topology lock → DB B-Tree SQL `(pending_tasks=0 AND open_conflicts=0)`. Only component allowed to emit `scope_closed`. Embedded in Control Plane daemon (not a separate Worker). Ref: ADR 19, ADR 28.

**REQ-09**: Context OOM 3-tier degradation chain (ADR 13 supplement): Tier 1 = N_root LLM distillation to 10-20% (⚠️ LLM call, requires explicit annotation); Tier 2 = N_current tail-truncation (last 2000 tokens); Tier 3 = Control Plane direct-writes `context_oom_throttled`, Scope enters Suspended state. Ref: `docs/adr/0024-adr13-supplement-context-oom-degradation.md`.

**REQ-10**: Wasm tokenizer: `@dqbd/tiktoken` loaded as Wasm in Node.js. Used for W_max budget calculation in Knapsack Slicing. Sub-1ms token count. Ref: `docs/TECH_STACK.md`.

### Worker Framework

**REQ-11**: Workers registered via `iii-sdk` `registerWorker()` / `registerFunction()`. Workers hold `GraphHandle` with `write()` method. Tools hold `ReadOnlyGraphHandle` without `write()`. TypeScript abstract base classes enforce this at compile time — `Tool` class MUST NOT expose `write()` method signature. DI runtime context throws `SecurityException` if `write()` called from Tool context. Ref: ADR 35 D-8.

**REQ-12**: Worker lifecycle state machine (ADR 27): 4 phases — Initializing (context assembly) → Processing (LLM calls; NO persistent writes allowed) → Writing (CTE commits) → Terminated. `Knapsack failure` bifurcation: size-cause → OOM chain; load-cause → re-queue up to N=3 retries → then OOM chain. No event silently dropped. Ref: `docs/adr/0029-adr27-worker-lifecycle-state-machine.md`.

**REQ-13**: Knowledge entity write timing (ADR 36 D-9): Every tool result representing a state change MUST be written to Execution Graph immediately after the tool returns. Use `ON CONFLICT DO NOTHING` for idempotency. Read-only tool calls (e.g., `list_files`) MAY be omitted at Worker author's discretion. Ref: `docs/adr/0038-adr36-knowledge-entity-write-timing.md`.

**REQ-14**: Subagent scope branching Phase 1 model (ADR 34 D-7): Sub-worker creates child Scope UUID, appends `spawned_by` hyperedge `(parent_scope_id, child_scope_id, "scope_spawned", version_hash, timestamp)`. `MAX_CHILD_SCOPE_DEPTH = 3`. In-process execution only (Phase 1). Guard: env var `GRAPH_AGENT_CHILD_SCOPE` + payload field `spawned_by_scope`. Ref: `docs/adr/0036-adr34-subagent-scope-branch-model.md`.

### HTTP Gateway

**REQ-15**: HTTP Gateway (ADR 24) built with Hono or Fastify. Three endpoints: `POST /v1/scopes` (create scope, triggers DDL nesting), `POST /v1/scopes/{id}/events` (submit event, returns assembled Knapsack context), `GET /v1/scopes/{id}` (read scope state). Gateway is not a stateless proxy — it holds inline Watchdog SQL and direct-write rights for `scope_closed` and `context_oom_throttled`. Ref: `docs/adr/0026-adr24-agent-entry-point-protocol.md`.

**REQ-16**: All Gateway inputs MUST be validated via Zod: UUID v4 regex for scope IDs, `/^[0-9a-f]{64}$/` for hash fields. Validation failure returns 400 immediately without touching the database. Ref: ADR 24.

### Queue Adapter & Idempotency

**REQ-17**: `PgQueueAdapter` implements `IQueueAdapter` interface (Phase 2 Redis replacement point). Uses `FOR UPDATE SKIP LOCKED` to dequeue events. LISTEN/NOTIFY serves as wakeup signal only — zero data in the notification payload. When all 4 Worker slots are occupied, stop calling `nextEvent()`. Ref: ADR 32 D-4, `docs/adr/0034-adr32-pgqueueadapter-and-idempotency.md`.

**REQ-18**: Idempotency: `UNIQUE(scope_id, entity_id, version_hash)` database constraint. All Worker writes use `ON CONFLICT DO NOTHING`. At-least-once re-delivery is transparent to Workers. Ref: ADR 32 D-5.

### Frontier Scheduler

**REQ-19**: `graph::scheduler::frontier` Worker (ADR 31). Subscribes to `graph::frontier::changed` topic. Token bucket: 50ms window, prevents cascade storm. Priority SQL Top-K: `dynamic_score = base_priority×10 + age_bonus(≤20) + unlocks_count×5 + spawned_by_bonus(3) + active_bonus(15)`. Tie-break by `created_at ASC` (FIFO). No priority inversion possible (age_bonus cap < min priority gap). iii engine handles FIFO only — all priority logic lives in PostgreSQL + this Worker. Ref: `docs/adr/0033-adr31-frontier-scheduler-architecture.md`, `docs/adr/0031-adr29-worker-tool-knowledge-boundaries.md` §Frontier formula.

### Context Assembly

**REQ-20**: Context Assembly (ADR 30 D-1 + D-2): 3-layer prompt structure — Layer 1 Stable (system role, Anthropic prompt cache eligible), Layer 2 Context (causal lineage Knapsack projection from graph), Layer 3 Volatile (current input, rebuilt each call). Overflow = Zero-LLM 3-tier lossy reverse-chronological sliding window discard (newest events first, physically truncate at W_max, no LLM calls, no `context_compressed` entity creation). `IOverflowStrategy` interface reserved but NOT activated in Phase 1. Ref: `docs/adr/0032-adr30-context-assembly-strategy.md`.

### LLM Provider Abstraction

**REQ-21**: `LLMProvider` and `EmbeddingProvider` interfaces defined in the iii-engine layer (not Worker layer). Phase 1 implements exactly one provider: OpenAI-compatible REST (`/v1/chat/completions` + `/v1/embeddings`), covering ollama / llama.cpp / lmstudio / OpenAI. Workers MUST NOT hold LLM credentials — credentials live in `iii-config.yaml` only. Embedding calls NOT counted against Worker token budget; logged in iii-observability separately. Ref: ADR 22 D-1.

### Pattern Discovery Stub

**REQ-22**: `graph::patterns::discover` Worker registered with `base_priority = 1` (lowest). Runs on cron schedule (default: every 6 hours). Minimum corpus guard: skip if `completed_scope_count < MIN_CORPUS_THRESHOLD` (default: 10). MUST NOT subscribe to `scope_completed` event inline. MUST NOT use any of the 4 OLTP Worker slots during burst completion periods. Cold start: system operates as single-session agent until patterns emerge. Ref: ADR 37 D-10, `docs/adr/0039-adr37-pattern-discovery-schedule.md`.

### Scope Identity

**REQ-23**: Scope UUID tracks logical business task identity. Context window overflow MUST NOT trigger Scope UUID rotation — overflow is handled by Context Assembly sliding window (REQ-20). `f(Scope UUID) = business identity` and `f(context_window_size) = view parameter` are orthogonal. Ref: ADR 33 D-6, `docs/adr/0035-adr33-scope-identity-boundary.md`.

## Notes

- ADR references above are canonical. When implementation details conflict with these requirements, the ADR is authoritative.
- G1-G4 deferred research items (traversal algebra, pattern language, embedding training, materialized paths) are NOT Phase 1 scope.
- Pi sandbox (ADR Phase 4), MCP adapter (Phase 2+), and nested scope full activation (Phase 3) are explicitly out of scope for Phase 1.
