# Roadmap: Graph-Native Agent Runtime

## Overview

Building a graph-native agent runtime where the append-only PostgreSQL execution graph is the single source of truth. Workflows emerge from accumulated cognitive traces rather than being designed. The context window is a causal projection of the graph. 37 ADRs locked as of 2026-06-01 — architecture is fully specified, Phase 1 implementation begins now.

## Phases

- [ ] **Phase 1: Core Graph Engine** — PostgreSQL schema, Control Plane daemon, Worker framework, HTTP Gateway, Frontier Scheduler, Context Assembly
- [ ] **Phase 2: Memory & Retrieval** — BM25+RRF hybrid retrieval, MemorySynthesizer, full ConflictResolverWorker, reflection track
- [ ] **Phase 3: Pattern Discovery** — WL graph kernel, topology embeddings, CrossScopePatternDiscovery, nested scopes activation
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
**Plans**: 10 plans
- [ ] 01-01-PLAN.md — Project scaffold + tooling + canonical_json (shared package)
- [ ] 01-02-PLAN.md — PostgreSQL schema migrations (event log, memory tables, lineage)
- [ ] 01-03-PLAN.md — OCC Writable CTE + pgcrypto hash chain + idempotency
- [ ] 01-04-PLAN.md — Control Plane Daemon (nesting, pg-listen Pulse-Fetch, Watchdog, OOM)
- [ ] 01-05-PLAN.md — Worker/Tool ABC framework + lifecycle + subagent branching
- [ ] 01-06-PLAN.md — PgQueueAdapter + Frontier Scheduler
- [ ] 01-07-PLAN.md — HTTP Gateway (Hono, 3 endpoints, inline Watchdog, context)
- [ ] 01-08-PLAN.md — Context Assembly (tiktoken, Knapsack, Zero-LLM overflow)
- [ ] 01-09-PLAN.md — LLM Provider abstraction + core Workers
- [ ] 01-10-PLAN.md — Pattern Discovery cron stub

### Phase 2: Memory & Retrieval
**Goal**: Full hybrid BM25+RRF retrieval across all three memory tables, complete ConflictResolverWorker with LLM-assisted merge, MemorySynthesizer with Ebbinghaus decay, and `mem::reflect` function with token budget enforcement.
**Depends on**: Phase 1
**Requirements**: TBD
**Success Criteria** (what must be TRUE):
  1. `mem::reflect` query returns hybrid-retrieved memories with `rrf_score × 0.6 + quality × 0.3 + recency × 0.1` ranking
  2. ConflictResolverWorker resolves entity-level conflicts with ActiveResolverRegistry mutex (in-memory)
  3. MemorySynthesizer fires at 2 AM cron OR on `scope_closed` + ≥20 episodic records
  4. Ebbinghaus decay scan marks `reinforcement_count=0 AND last_used_at < 90 days` as superseded
**Plans**: TBD

### Phase 3: Pattern Discovery
**Goal**: WL graph kernel with topology_embedding computation, CrossScopePatternDiscoveryWorker, nested Scope activation (ADR 23 Phase 3 stubs removed), SubScopeResultWorker.
**Depends on**: Phase 2
**Requirements**: TBD
**Success Criteria** (what must be TRUE):
  1. Two topologically equivalent scopes from different domains have `topology_embedding` cosine similarity > 0.90
  2. CrossScopePatternDiscoveryWorker writes `cross_domain_cluster_id` for matching template pairs
  3. Nested scopes fully activate: child scope `scope_closed` propagates to parent via `sub_scope_resolved`
**Plans**: TBD

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
| 1. Core Graph Engine | 0/10 | Not started | - |
| 2. Memory & Retrieval | 0/TBD | Not started | - |
| 3. Pattern Discovery | 0/TBD | Not started | - |
| 4. External Integrations | 0/TBD | Not started | - |
