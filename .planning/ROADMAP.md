# Roadmap: Graph-Native Agent Runtime

## Overview

Building a graph-native agent runtime where the append-only PostgreSQL execution graph is the single source of truth. Workflows emerge from accumulated cognitive traces rather than being designed. The context window is a causal projection of the graph. 37 ADRs locked as of 2026-06-01 — architecture is fully specified, Phase 1 implementation begins now.

## Phases

- [ ] **Phase 1: Core Graph Engine** — PostgreSQL schema, Control Plane daemon, Worker framework, HTTP Gateway, Frontier Scheduler, Context Assembly
- [ ] **Phase 2: Memory & Retrieval** — BM25+RRF hybrid retrieval, MemorySynthesizer, full ConflictResolverWorker, reflection track
- [ ] **Phase 3: Pattern Discovery + MCP Bridging** — WL graph kernel, topology embeddings, CrossScopePatternDiscovery, nested scopes activation, MCP Server + agent_registry skill routing
- [ ] **Phase 4: External Integrations** — MCP adapter, Pi sandbox rehearsal mode, distributed locks

## Phase Details

### Phase 1: Core Graph Engine
**Goal**: Deliver a running PostgreSQL-backed agent execution graph with Control Plane daemon, TypeScript Worker framework, HTTP Gateway for external agent submission, Frontier Scheduler, and 3-layer Context Assembly. A single external agent can submit tasks, receive Knapsack-assembled context, write results back via OCC Writable CTE, and the system converges via the Topological Convergence Watchdog.
**Depends on**: Nothing (first phase)
**Requirements**: [REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-06, REQ-07, REQ-08, REQ-09, REQ-10, REQ-11, REQ-12, REQ-13, REQ-14, REQ-15, REQ-16, REQ-17, REQ-18, REQ-19, REQ-20, REQ-21, REQ-22, REQ-23]
**Success Criteria** (what must be TRUE):
  1. `POST /v1/scopes` creates a scope and returns its UUID after completing the 3-phase DDL nesting protocol
  2. `POST /v1/scopes/{id}/events` accepts a canonical event payload, computes SHA-256 version_hash via pgcrypto, returns assembled Knapsack context
  3. OCC concurrent writes to the same entity: first writer gets `memory_updated`, second gets `conflict_detected` with causal inversion — both via Writable CTE in a single transaction
  4. Worker processes an event through all 4 lifecycle phases (Initializing → Processing → Writing → Terminated) per ADR 27
  5. Frontier Scheduler dispatches events with `dynamic_score = base_priority×10 + age_bonus(≤20) + unlocks_count×5 + spawned_by_bonus(3) + active_bonus(15)` without any LLM calls
  6. Context Assembly produces 3-layer prompt (Stable / Causal / Volatile) with Zero-LLM overflow discard when W_max exceeded
  7. Worker class fails to compile if it calls `write()` via a Tool context (TypeScript ABC enforcement, ADR 35)
  8. canonical_json produces deterministic output for the same payload regardless of insertion order (BTreeMap application-layer serialization)
  9. Pattern discovery cron fires every 6 hours; skips if `completed_scope_count < 10`; does not acquire any OLTP worker slots
**Plans**: 11 plans
- [x] 01-01-PLAN.md — Project scaffold + tooling + canonical_json (shared package)
- [x] 01-02-PLAN.md — PostgreSQL schema migrations (event log, memory tables, lineage)
- [x] 01-03-PLAN.md — OCC Writable CTE + pgcrypto hash chain + idempotency
- [x] 01-04-PLAN.md — Control Plane Daemon (nesting, pg-listen Pulse-Fetch, Watchdog, OOM)
- [x] 01-05-PLAN.md — Worker/Tool ABC framework + lifecycle + subagent branching
- [x] 01-06-PLAN.md — PgQueueAdapter + Frontier Scheduler
- [x] 01-07-PLAN.md — HTTP Gateway (Hono, 3 endpoints, inline Watchdog, context)
- [x] 01-08-PLAN.md — Context Assembly (tiktoken, Knapsack, Zero-LLM overflow)
- [x] 01-09-PLAN.md — LLM Provider abstraction + core Workers
- [x] 01-10-PLAN.md — Pattern Discovery cron stub
- [x] 01-11-PLAN.md — pino structured logger (shared package, all 3 components)

### Phase 2: Memory & Retrieval
**Goal**: Full hybrid BM25+RRF retrieval across all three memory tables, complete ConflictResolverWorker with LLM-assisted merge, MemorySynthesizer with Ebbinghaus decay, and `mem::reflect` function with token budget enforcement.
**Depends on**: Phase 1
**Requirements**: [MEM-01, MEM-02, MEM-03, MEM-04, MEM-05]
**Success Criteria** (what must be TRUE):
  1. `mem::reflect` query returns hybrid-retrieved memories with `rrf_score × 0.6 + quality × 0.3 + recency × 0.1` ranking
  2. ConflictResolverWorker resolves entity-level conflicts with ActiveResolverRegistry mutex (in-memory)
  3. MemorySynthesizer fires at 2 AM cron OR on `scope_closed` + ≥20 episodic records
  4. Ebbinghaus decay scan marks `reinforcement_count=0 AND last_used_at < 90 days` as superseded
**Execution Plans:**
- 02-01-PLAN.md — Schema extensions (migration 006): episodic entity_id, semantic HNSW, procedural decay columns, working_memory dedup_hash
- 02-02-PLAN.md — EpisodicMemoryWorker + durable:subscriber registration
- 02-03-PLAN.md — SemanticMemoryWorker + scope_closed trigger + LLM distillation
- 02-04-PLAN.md — MemorySynthesizerWorker: synthesis/decay/TTL cron (3 triggers)
- 02-05-PLAN.md — ProceduralMemoryWorker + WL kernel embedding utility
- 02-06-PLAN.md — Hybrid BM25+HNSW RRF retrieval + GET /v1/memory/search + POST /v1/memory/reinforce
- 02-07-PLAN.md — Working memory SHA-256 dedup + ConflictResolverWorker LLM merge
- 02-08-PLAN.md — Gate 3 integration tests G3-1 through G3-7

### Phase 3: Pattern Discovery + MCP Bridging
**Goal**: WL graph kernel with topology_embedding computation and cross-domain clustering (CrossScopePatternDiscoveryWorker writing `cross_domain_cluster_id`), nested Scope activation (ADR 23 stubs removed: child `scope_closed` → `sub_scope_resolved` → SubScopeResultWorker), and a cross-protocol MCP Server bridging layer (7 MCP tools, `agent_registry` with GIN skill matching, FrontierScheduler skill-routing extension, AgentCard endpoints) so external Agents interact with the causal ledger via standard protocols.
**Depends on**: Phase 2
**Requirements**: [GATE4-1, GATE4-2, GATE4-3, GATE4-4, GATE4-5]
**Success Criteria** (what must be TRUE):
  1. (GATE4-1) Two topologically equivalent scopes from different domains have `topology_embedding` cosine similarity > 0.90
  2. (GATE4-2) CrossScopePatternDiscoveryWorker writes `cross_domain_cluster_id` for matching template pairs (topology cosine > 0.90 AND intent distance > 0.50)
  3. (GATE4-3) Nested scopes fully activate: child scope `scope_closed` propagates to parent via `sub_scope_resolved` and the parent spawning task advances
  4. (GATE4-4) External Agent (MCP client) can call `spawn_subtask` + `claim_next_task` + `complete_task` against a live graph-os instance
  5. (GATE4-5) FrontierScheduler dispatches tasks by skill match (`required_skills[]` against `agent_registry.skills` via GIN), not arbitrary assignment
**Plans**: 7 plans
- [x] 03-01-PLAN.md — Wave 0 schema: migration 007 (agent_registry + intent_embedding + cross_domain_cluster_id) + ProceduralMemoryWorker intent_embedding + RED test scaffolds
- [ ] 03-02-PLAN.md — CrossScopePatternDiscoveryWorker (union-find clustering + discover.worker body)
- [ ] 03-03-PLAN.md — FrontierScheduler skill-matching extension (opt-in GIN && filter)
- [ ] 03-04-PLAN.md — Nested scope activation (Control Plane sub-scope creation + sub_scope_resolved injection + Pulse-Fetch routing)
- [ ] 03-05-PLAN.md — MCP Server (7 tools) + transport mount + AgentCard endpoints
- [ ] 03-06-PLAN.md — SubScopeResultWorker + internal Worker AgentCard bootstrap (D-2)
- [ ] 03-07-PLAN.md — Gate 4 integration tests (GATE4-1 through GATE4-5)

### Phase 4: External Integrations
**Goal**: MCP adapter with per-event-type cognitive translation tools, Pi SDK `runtime.fork()` sandbox rehearsal mode, distributed lock for ConflictResolverWorker (replacing in-memory Phase 1 implementation).
**Depends on**: Phase 3
**Requirements**: TBD
**Success Criteria** (what must be TRUE):
  1. Claude Code can call `spawn_task` / `complete_task` as native MCP tool calls
  2. `runtime.fork(entryId)` + `SessionManager.inMemory()` rehearsal validates topology before OCC commit
  3. ConflictResolverWorker uses distributed lock (not in-memory ActiveResolverRegistry)
**Plans**: TBD

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Core Graph Engine | 11/11 | Complete | 2026-06-03 |
| 2. Memory & Retrieval | 8/8 | Complete | 2026-06-04 |
| 3. Pattern Discovery + MCP Bridging | 1/7 | In progress | - |
| 4. External Integrations | 0/TBD | Not started | - |
