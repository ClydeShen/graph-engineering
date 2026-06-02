# Phase 1: Core Graph Engine — Context

**Gathered:** 2026-06-02
**Status:** Ready for planning
**Source:** ADR Express Path (37 locked ADRs, 2026-06-01)

<domain>
## Phase Boundary

Phase 1 delivers the minimum viable graph-native agent execution system:
- **PostgreSQL SSOT**: append-only `execution_event_log` (partitioned by scope), pgcrypto SHA-256 hash chain, four memory tables (schema stubs for Phase 2+)
- **Control Plane Daemon**: TypeScript, `pg-listen` Pulse-Fetch bridge, exclusive DDL connection, 3-phase nesting protocol, Topological Convergence Watchdog
- **Worker Framework**: TypeScript `iii-sdk`, `GraphHandle`/`ReadOnlyGraphHandle` ABC boundary, 4-phase lifecycle state machine, per-tool-result write discipline
- **HTTP Gateway**: Hono/Fastify, 3 REST endpoints, Zod validation, inline Watchdog SQL
- **Queue Adapter**: `PgQueueAdapter` with `FOR UPDATE SKIP LOCKED`, `IQueueAdapter` abstraction for Phase 2 Redis
- **Frontier Scheduler**: `graph::scheduler::frontier` Worker, token bucket 50ms, priority SQL Top-K
- **Context Assembly**: 3-layer prompt (Stable/Context/Volatile), Zero-LLM sliding window overflow discard
- **Pattern Discovery stub**: cron-only, base_priority=1, MIN_CORPUS=10 guard

Out of scope for Phase 1:
- BM25+RRF retrieval implementation (schema columns only)
- ConflictResolverWorker LLM-assisted merge (OCC hard-stop is enough for Phase 1)
- MemorySynthesizer
- Nested scope full activation (forward-compat stubs only)
- MCP adapter
- Pi sandbox
- Distributed locks
- G1-G4 deferred research (traversal algebra, pattern language, embedding training, materialized paths)

</domain>

<decisions>
## Implementation Decisions

All decisions below are LOCKED (ADR status: Approved). ADR file references are authoritative.

### Hash Chain & Canonical JSON
- `canonical_json` MUST be implemented in TypeScript via `Object.keys().sort()` recursive traversal (BTreeMap equivalent). PostgreSQL side receives pre-serialized TEXT — NEVER does `::jsonb` conversion. [ADR 02 P0-D]
- Version Hash formula: `pgcrypto.digest(scope_id|entity_id|predecessor_hash|event_type|canonical_json_text, 'sha256')` inside Writable CTE. [ADR 02]
- `graph_root` (plan_created) uses ZERO_HASH `0000...0000` (64 zeros) as predecessor_hash sentinel. [ADR 02]
- Hashable domain = `payload` minus `_meta` minus `schema_version` — both stripped by application layer BEFORE hash input. [CONTEXT.md §Version Hash]

### PostgreSQL Schema
- `execution_event_log`: PARTITION BY LIST(scope_id). Each Scope gets its own partition sub-table. [ADR 01]
- OCC hard-stop: `UNIQUE(predecessor_hash, scope_id)` constraint on each partition. First writer wins. [ADR 11]
- Five canonical event types ONLY — any other type rejected at bus level: `plan_created`, `task_spawned`, `memory_updated`, `conflict_detected`, `scope_closed`. [ADR 12]
- Four memory tables: `episodic_memory`, `semantic_memory`, `procedural_memory`, `working_memory`. Each gets `ts_doc tsvector GENERATED ALWAYS` column (BM25 Phase 2 prep). `procedural_memory` gets `topology_embedding vector(128)` with HNSW `m=16, ef_construction=64` (WL kernel Phase 3 stub). [ADR 20, ADR 25]
- `scope_lineage` cold table: NOT an event log, NOT append-only. Written during DDL nesting protocol. [ADR 23]
- Composite index `idx_scope_{id}_pending_lookup` created at nesting time per ADR 13 and ADR 19. [ADR 13, ADR 19]

### OCC & Writable CTE
- OCC atomic causal inversion: when second writer loses, its `predecessor_hash` is rewritten to point to winner, `version_hash` recomputed with the SAME `canonical_json_text` in the same CTE transaction — NO application callback, NO `::jsonb` conversion. [ADR 11, ADR 02]
- Both winner and loser receive deterministic signal (`won` / `demoted`) — no retry, no exception. [ADR 11]

### Control Plane Daemon
- TypeScript process. Two DB connection pools: (1) DDL exclusive (for nesting protocol, must not share), (2) event read + LISTEN/NOTIFY. [ADR 05, ARCHITECTURE.md]
- Pulse-Fetch Bridge: `pg-listen` fires callback → advance HWM in `bus_state` → call `iii.trigger(worker_type, event_id)`. LISTEN/NOTIFY carries no data payload. [ADR 09, ADR 32 D-4]
- 3-phase nesting protocol (ADR 05): Phase 1 = CREATE PARTITION + HNSW index (DDL exclusive); Phase 2 = INSERT scope_lineage; Phase 3 = INSERT plan_created event. Single DDL transaction.
- Convergence Watchdog: 3-tier defense (atomic counter in-memory → conflict lock → DB SQL `pending_tasks=0 AND open_conflicts=0`). ONLY source of `scope_closed`. Embedded in Control Plane, NOT a separate Worker. [ADR 19, ADR 28]
- Context OOM chain: Tier 1 LLM distill (annotated as LLM call) → Tier 2 tail-truncate N_current → Tier 3 direct-write `context_oom_throttled`. [ADR 13 supplement]
- Wasm tokenizer: `@dqbd/tiktoken` loaded in Node.js for sub-1ms W_max calculation. [TECH_STACK.md]

### Worker Framework
- TypeScript abstract base classes: `Worker` holds `GraphHandle` (has `write()`); `Tool` holds `ReadOnlyGraphHandle` (no `write()` in signature). Compile error if Tool tries to call `write()`. DI runtime throws `SecurityException`. [ADR 35 D-8]
- `sdk.registerWorker` vs `sdk.registerTool` — wrong registration causes compile error. [ADR 35]
- Worker lifecycle: Initializing → Processing → Writing → Terminated. During Processing: ZERO persistent writes allowed. LLM results stay in memory until Writing phase. [ADR 27]
- Knapsack failure bifurcation: size-caused → OOM 3-tier chain; load-caused → re-queue max 3 times → then OOM chain. No silent drops. [ADR 27]
- Knowledge entity write timing: every tool result with state change written IMMEDIATELY after tool returns, via `ON CONFLICT DO NOTHING`. Crash-safe: graph contains all completed writes even if Worker dies mid-execution. Read-only calls (e.g., `list_files`) may be omitted at Worker author's discretion. [ADR 36 D-9]
- Subagent branching Phase 1: in-process only. Child creates child Scope UUID, appends `spawned_by` hyperedge. `MAX_CHILD_SCOPE_DEPTH = 3`. Guards: env `GRAPH_AGENT_CHILD_SCOPE` + payload field `spawned_by_scope`. [ADR 34 D-7]

### HTTP Gateway
- Hono or Fastify. Three endpoints: `POST /v1/scopes`, `POST /v1/scopes/{id}/events`, `GET /v1/scopes/{id}`. [ADR 24]
- Gateway is NOT a stateless proxy. Holds inline Watchdog SQL + direct-write rights for infrastructure events (`scope_closed`, `context_oom_throttled`). DDL rights stay with Control Plane daemon. [ADR 24]
- Every `POST /v1/scopes/{id}/events` synchronously assembles Knapsack context and returns it in the response. On `scope_closed`: context=null signals Agent to terminate. [ADR 24]
- Zod validation: UUID v4 regex for all IDs, `/^[0-9a-f]{64}$/` for all hash fields. Failure → 400 immediately. [ADR 24]
- External agents (including Claude Code) are External Participants — submit events via Gateway, do NOT call `sdk.registerFunction`. [ADR 29]

### Queue Adapter & Idempotency
- `PgQueueAdapter` implements `IQueueAdapter` interface. Dequeue: `FOR UPDATE SKIP LOCKED`. Wakeup: LISTEN/NOTIFY (no data in payload). Backpressure: stop calling `nextEvent()` when all 4 Worker slots full. [ADR 32 D-4]
- Idempotency: `UNIQUE(scope_id, entity_id, version_hash)`. Worker writes use `ON CONFLICT DO NOTHING`. At-least-once re-delivery is transparent. [ADR 32 D-5]

### Frontier Scheduler
- `graph::scheduler::frontier` Worker. Subscribes to `graph::frontier::changed` topic. Token bucket: 50ms window (prevents cascade storm). [ADR 31]
- Priority SQL: `dynamic_score = base_priority×10 + age_bonus(≤20) + unlocks_count×5 + spawned_by_bonus(3) + active_bonus(15)`. Tie-break: `created_at ASC` (FIFO). Age cap ensures no priority inversion is mathematically possible. [ADR 31, ADR 29 §Frontier formula]
- iii engine FIFO only. All priority logic in PostgreSQL + this Worker — NEVER inside iii. [ADR 31]

### Context Assembly
- 3-layer prompt: Layer 1 Stable (system role, Anthropic prompt cache eligible), Layer 2 Context (Knapsack causal lineage projection from graph), Layer 3 Volatile (current input, rebuilt every call). [ADR 30 D-1]
- Overflow = Zero-LLM 3-tier lossy reverse-chronological sliding window: newest events pack first, truncate physically at W_max. NO LLM calls, NO `context_compressed` entity, NO modification of graph structure. [ADR 30 D-2]
- `IOverflowStrategy` interface: reserve the interface but DO NOT activate it in Phase 1. [ADR 30]
- Knapsack Slicing: vertical axis = predecessor_hash back to N_root (causal skeleton); horizontal axis = pending/conflict siblings in same scope; fill W_max with reverse-chronological ancestors. [CONTEXT.md §Knapsack Slicing]
- Graph → Context is a ONE-WAY projection. Context state NEVER mutates the graph. [CLAUDE.md §Paradigm]

### LLM Provider Abstraction
- `LLMProvider` and `EmbeddingProvider` interfaces live in iii-engine layer. Workers call the interface — NEVER hold credentials directly. [ADR 22 D-1]
- Phase 1: implement ONE provider — OpenAI-compatible REST (`/v1/chat/completions` + `/v1/embeddings`). Covers ollama, llama.cpp, lmstudio, OpenAI. [ADR 22]
- Embedding calls: logged in iii-observability separately, NOT counted against Worker △_padding token budget. [ADR 22]
- Explicit LLM call annotation: EVERY place that calls LLM MUST be annotated with the ADR that justifies it. [ADR 22 D-1 principle]

### Pattern Discovery Stub
- `graph::patterns::discover` Worker. `base_priority = 1` (lowest possible). Cron: every 6 hours (configurable). [ADR 37 D-10]
- Minimum corpus guard: `IF completed_scope_count < 10 THEN RETURN`. No pattern run without sufficient data. [ADR 37]
- MUST NOT subscribe to `scope_completed` inline. MUST NOT preempt OLTP Worker slots. Cold start = graceful degradation as single-session agent. [ADR 37]

### Scope Identity
- Scope UUID tracks BUSINESS TASK IDENTITY — completely independent of context window size. [ADR 33 D-6]
- Context overflow NEVER triggers UUID rotation. `f(Scope UUID)` and `f(context_window_size)` are orthogonal. [ADR 33]

### Claude's Discretion
- TypeScript project structure, module layout, file naming
- iii-config.yaml format and configuration values
- Specific table column types beyond what ADRs specify (e.g., timestamp precision)
- Test framework and test file locations
- Error message strings
- Logging format
- HTTP port configuration
- Development vs production config separation

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Domain Model & Terminology
- `CONTEXT.md` — canonical glossary (Execution Graph, Entity, Version, Hyper-edge, Scope, OCC, Knapsack Slicing, Convergence Watchdog, etc.)

### Architecture
- `docs/ARCHITECTURE.md` — Phase 1 implementable reference (ASCII diagram, component roles, "what we build" vs "what is pre-installed")
- `docs/TECH_STACK.md` — exact technology versions, npm package names, copy-pasteable code index

### ADR Layer 1–7 (Core Architecture)
- `docs/ADR_v4.md` — master reference for all 37 ADRs (ADR 01–37 with full decision text)

### Phase 1 ADR Supplements (MUST READ before implementing their components)
- `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` — BM25+RRF SQL template (Phase 2 schema prep)
- `docs/adr/0022-adr21-reflection-track-trigger-spec.md` — mem::reflect token budget
- `docs/adr/0023-adr22-llm-provider-abstraction.md` — LLMProvider/EmbeddingProvider interfaces
- `docs/adr/0024-adr13-supplement-context-oom-degradation.md` — 3-tier OOM degradation chain
- `docs/adr/0025-adr23-nested-scope-propagation.md` — Phase 1 sub-scope forward-compat stubs
- `docs/adr/0026-adr24-agent-entry-point-protocol.md` — HTTP Gateway spec (3 endpoints, Zod, Watchdog inline)
- `docs/adr/0027-adr25-cross-domain-topology-algorithm.md` — topology_embedding vector(128) schema stub
- `docs/adr/0028-adr26-event-as-snapshot-philosophy.md` — Event-as-Snapshot, NO fold/reduce
- `docs/adr/0029-adr27-worker-lifecycle-state-machine.md` — 4-phase lifecycle, Knapsack failure bifurcation
- `docs/adr/0030-adr28-scheduling-spec-and-operational-determinism.md` — convergence SQL, Max_Parallelism formula
- `docs/adr/0031-adr29-worker-tool-knowledge-boundaries.md` — 4-element boundary (Worker/Tool/Knowledge/Connector)
- `docs/adr/0032-adr30-context-assembly-strategy.md` — 3-layer prompt, Zero-LLM overflow
- `docs/adr/0033-adr31-frontier-scheduler-architecture.md` — token bucket, priority SQL formula
- `docs/adr/0034-adr32-pgqueueadapter-and-idempotency.md` — FOR UPDATE SKIP LOCKED, IQueueAdapter
- `docs/adr/0035-adr33-scope-identity-boundary.md` — UUID orthogonality to context size
- `docs/adr/0036-adr34-subagent-scope-branch-model.md` — spawned_by hyperedge, MAX_DEPTH=3
- `docs/adr/0037-adr35-worker-tool-boundary-enforcement.md` — TypeScript ABC, DI SecurityException
- `docs/adr/0038-adr36-knowledge-entity-write-timing.md` — per-tool-result write, crash safety
- `docs/adr/0039-adr37-pattern-discovery-schedule.md` — OLAP cron, MIN_CORPUS guard

### Research Reports
- `.harness/research/iii-engine.md` — iii engine API surface, registerWorker/registerFunction patterns
- `.harness/research/tech.md` — technology stack verification
- `.harness/research/deep-cross-validation-round2.md` — 12/12 concept cross-validation

</canonical_refs>

<specifics>
## Specific Implementation Details

- **iii engine**: pre-installed binary, NOT our code. Use `npm install iii-sdk` for the SDK. Workers connect via WebSocket to the iii Engine WebSocket Server.
- **pg-listen**: `npm install pg-listen`. Used for LISTEN/NOTIFY in Control Plane Pulse-Fetch bridge.
- **@dqbd/tiktoken**: Wasm tokenizer, ~2-line load in Node.js. Used for W_max budget calculation ONLY.
- **pgcrypto**: PostgreSQL extension. `CREATE EXTENSION IF NOT EXISTS pgcrypto;` — must be in schema migration.
- **pgvector**: PostgreSQL extension. Used for `vector(128)` topology embedding and `vector(1536)` semantic embedding columns. `CREATE EXTENSION IF NOT EXISTS vector;`
- **Hono vs Fastify**: Both acceptable for HTTP Gateway. Hono preferred for its Zod integration and smaller footprint in edge-adjacent environments.
- **iii-config.yaml**: Worker slot count (default 4), LLM provider credentials, cron schedules, Max_Parallelism parameters.
- **Frontier score formula (ADR 29 §Frontier)**: `priority×10 + age_bonus(≤20) + unlocks_count×5 + spawned_by_bonus(3) + active_bonus(15)`
- **Wasm tokenizer load example** (from TECH_STACK.md): `import { encoding_for_model } from '@dqbd/tiktoken'; const enc = encoding_for_model('gpt-4'); const count = enc.encode(text).length;`

</specifics>

<deferred>
## Deferred to Phase 2+

- BM25+RRF retrieval queries (schema columns created in Phase 1 as stubs)
- `mem::reflect` function full implementation (interface defined, not implemented)
- ConflictResolverWorker LLM-assisted merge (OCC Writable CTE handles Phase 1)
- MemorySynthesizer (including Ebbinghaus decay)
- Nested scope full activation (ADR 23 Phase 3 stubs only in Phase 1)
- Redis queue adapter (IQueueAdapter interface reserved)
- MCP adapter for Claude Code native tool calls (Phase 2)
- Pi sandbox / `runtime.fork()` (Phase 4)
- Distributed locks for ConflictResolverWorker (Phase 4)
- G1: Traversal algebra for CrossScopePatternDiscovery
- G2: Pattern definition language for TemplateProposalWorker
- G3: Embedding training strategy (128-dim column reserved in schema)
- G4: Materialized traversal cache
- `IOverflowStrategy` interface activation (defined but not activated)
- `pgvector 0.8.0 hnsw.iterative_scan` optimization (Phase 3)
- SubScopeResultWorker (requires Phase 3 nested scope activation)

</deferred>

---

*Phase: 01-core-graph-engine*
*Context gathered: 2026-06-02 via ADR Express Path (37 locked ADRs)*
