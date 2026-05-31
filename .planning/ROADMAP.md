# Roadmap: Graph-Native Agent Runtime

## Phase 1 — MVP: OCC Proof-of-Concept

**Goal:** On a single machine, prove that concurrent writes against the same `predecessor_hash` resolve atomically via Writable CTE causal inversion, the conflict wakes the ConflictResolverWorker, and the system writes a valid convergence node with no deadlocks.

**Deliverables:**
- `migrations/001_initial.sql` — `execution_event_log` (unpartitioned), `procedural_memory`, `bus_state`, pgcrypto + pgvector extensions; `AFTER INSERT` trigger for `pg_notify`
- `workers/control-plane/` — **TypeScript** (NOT Rust): `pg-listen` LISTEN/NOTIFY → `iii.trigger()` bridge; HWM tracking (`bus_state`); DDL exclusive connection for 3-phase nesting (ADR 05/09)
- `workers/conflict-resolver/` — TypeScript: subscribe to `conflict_detected` via `iii-sdk registerFunction()`; call LLM (forced `emit_convergence_gate` tool); write convergence node via Writable CTE
- `migrations/002_procedural_memory_rrf.sql` — two-phase ANN+RRF stored procedure
- `tests/occ_stress.ts` — concurrent write test: N goroutines hammer same predecessor_hash, assert exactly 1 winner + N-1 demoted + 1 convergence node

**Pass criteria:**
1. Stress test completes with zero DB errors
2. `SELECT event_type, count(*) FROM execution_event_log GROUP BY 1` shows expected shape
3. Convergence node present with valid `convergence_gate` JSON (both anchor hashes non-null)
4. RRF stored procedure returns ≥1 result for a seeded template

**Risks (updated 2026-06-01):**
- ~~`jsonb::text` key-sort assumption~~ ✅ **RESOLVED** — `canonical_json()` implemented in app layer (TypeScript BTreeMap recursive sort); PostgreSQL receives pre-normalized TEXT; ADR 02 corrected
- ~~tokio-postgres notification API shape~~ ✅ **RESOLVED** — not applicable; Control Plane Daemon uses TypeScript `pg-listen`, not Rust tokio-postgres
- Chinese tsvector tokenization — Phase 1 accepts `simple` config (CJK degradation to vector-only); Phase 3+ adds zhparser (ADR 20 supplement confirmed)
- **Cross-platform Pi spawn** — `child_process.spawn("pi", ...)` silently fails on Windows without `{ shell: true }`; must be set at Worker initialization, not at call site
- **iii install on Windows** — curl install script requires `sh`; use Docker (`pgvector/pgvector:pg16`) as primary development path on Windows (STATE.md risk #10)

---

## Phase 2 — Full Memory Layer

**Goal:** Complete the four-layer memory model. Add Episodic and Semantic memory tables. Prove Divergent Reflection Track injects useful context on cold-start.

**Deliverables:**
- `episodic_memory` table — HNSW vector index, intent/result summaries, `key_entities`
- `semantic_memory` table — `superseded_by` self-referential FK version chain, partial HNSW index (`WHERE superseded_by IS NULL`)
- `TemplateProposalWorker` — fired on `scope_closed`, audits DAG, writes positive/negative samples to `procedural_memory` + `episodic_memory`
- Divergent Reflection Track integration into Knapsack Slicing (token budget: `min(2000, W_max × 0.3)`)
- Three-layer retrieval order: Procedural → Episodic → Semantic

**Pass criteria:**
- After 3+ closed Scopes, cold-start for a similar Scope returns a Skeleton Graph from `procedural_memory`
- `episodic_memory` HNSW search returns the most semantically similar prior Scope summary

---

## Phase 3 — Production Hardening

**Goal:** Add LIST partitioning, three-phase DDL control plane, Δ_padding adaptive widening, and OCC back-pressure.

**Deliverables:**
- `PARTITION BY LIST (scope_id)` migration + dynamic partition creation in Control Plane Daemon (TypeScript, DDL exclusive connection, ADR 05)
- Three-phase nest protocol: intercept → exclusive DDL connection → `plan_created` atomic injection
- Δ_padding adaptive widening (1.5× penalty on tokenizer undercount)
- OCC contention back-pressure: rate-limit ConflictResolverWorker spawning per Scope
- `Topological Convergence Watchdog` — three-tier defense: in-memory counter → conflict topology lock → DB B-Tree final audit

**Pass criteria:**
- Hot-path Worker accounts physically cannot execute DDL (permission test)
- Partition creation completes under 500ms for typical HNSW index build
- Watchdog correctly fires `scope_closed` and does not double-fire

---

## Phase 4 — Distributed & Advanced

**Goal:** Multi-machine iii-engine, Wasm tokenizer sidecar, CDC inbound guard, Pi sandbox pre-execution simulation.

**Deliverables:**
- iii-engine multi-node clustering with consistent HWM across instances
- CDC inbound guard: filter `pg_notify` fanout from multiple iii-engine instances without thundering herd
- Wasm tokenizer plugin: <1ms token count, writes `payload._meta.tokens[model_fingerprint]`
- Pi sandbox pre-execution: virtual Scope replay before committing to main graph (ISSUE-28)
- Dynamic business-type contract registration → `procedural_memory` + Worker pre-prompt injection

**Pass criteria:**
- Two iii-engine nodes serve the same Scope without duplicating event delivery
- Wasm tokenizer measured at <1ms p99 on 4096-token payload
- Pi sandbox replay produces identical convergence topology to direct execution on a seeded test case

---

## Milestone Summary

| Milestone | Phase | Key Proof |
|---|---|---|
| Design | Phase 0 (done) | RFC_v4, ADR_v4, CONTEXT.md finalized |
| MVP | Phase 1 | OCC stress test passes, convergence node written |
| v0.5 | Phase 2 | Cold-start Skeleton Graph bootstrap proven |
| v1.0 | Phase 3 | Production-grade: partitioning, DDL control plane, watchdog |
| v2.0 | Phase 4 | Distributed, Wasm tokenizer, Pi sandbox |
