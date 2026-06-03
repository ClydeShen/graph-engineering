---
phase: 01-core-graph-engine
verified: 2026-06-03T05:30:00Z
status: human_needed
score: 9/9
overrides_applied: 0
human_verification:
  - test: "Confirm watchdog.ts OOM event uses 'suspended' status, not 'terminated'"
    expected: "control-plane watchdog.ts tier-3 OOM path writes status='suspended' (matching gateway watchdog-sql.ts fix, ADR 38)"
    why_human: "Code shows watchdog.ts line 196 still uses 'terminated' while watchdog-sql.ts line 162 uses 'suspended' — D6 fix was applied to the Gateway path but may not have been applied to the Control Plane Watchdog path. Cannot confirm from static analysis whether the CP path is exercised in production."
  - test: "Confirm graph-handle.ts Worker-level occWrite behaviour is intentional"
    expected: "Worker writes via GraphHandle use DO NOTHING semantics (not causal inversion). Only Gateway-submitted external events use causal inversion. Confirm this split is architecturally correct per ADR 11."
    why_human: "packages/workers/src/base/graph-handle.ts defines a local occWrite with ON CONFLICT DO NOTHING, separate from packages/shared/src/occ-write.ts (causal inversion). Gate 1 E2E only exercises the Gateway path. Whether Worker internal writes should also use causal inversion or DO NOTHING requires architect sign-off."
  - test: "Confirm nesting.ts pending-lookup index is correct"
    expected: "CREATE INDEX on (scope_id, status, event_id ASC) succeeds at runtime"
    why_human: "nesting.ts line 103 indexes event_id ASC but the DDL nesting runs inside a transaction; Gate 1 passed (Scenario A returned 201), implying the index creation succeeded. Static verification cannot substitute for observing the actual CREATE INDEX output in the DB."
---

# Phase 1: Core Graph Engine — Verification Report

**Phase Goal:** Deliver a running PostgreSQL-backed agent execution graph with Control Plane daemon, TypeScript Worker framework, HTTP Gateway for external agent submission, Frontier Scheduler, and 3-layer Context Assembly. A single external agent can submit tasks, receive Knapsack-assembled context, write results back via OCC Writable CTE, and the system converges via the Topological Convergence Watchdog.

**Verified:** 2026-06-03T05:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `POST /v1/scopes` creates scope + UUID after 3-phase DDL nesting | VERIFIED | `packages/gateway/src/routes/scopes.ts` calls `nestScope()` which runs 3-phase DDL transaction in `packages/control-plane/src/nesting.ts`; Gate 1 Scenario A passed (201, plan_hash returned) |
| 2 | `POST /v1/scopes/{id}/events` computes SHA-256 version_hash via pgcrypto, returns Knapsack context | VERIFIED | `packages/gateway/src/routes/events.ts` calls `occWrite` from `packages/shared/src/occ-write.ts`; hash formula uses pgcrypto `digest()` inside Writable CTE; assembleContext returns 3-layer context; Gate 1 Scenario B passed (occ_result=won, hash chain connected) |
| 3 | OCC concurrent writes: first=won (task_spawned/memory_updated), second=demoted (conflict_detected) via single Writable CTE transaction | VERIFIED | `packages/shared/src/sql/occ-writable-cte.sql.ts` `OCC_WRITE_SQL()` implements first-writer-wins with atomic causal inversion; ON CONFLICT DO UPDATE sets event_type='conflict_detected'; Gate 1 Scenario E passed (first=won, second=demoted) |
| 4 | Worker processes event through all 4 lifecycle phases (Initializing → Processing → Writing → Terminated) per ADR 27 | VERIFIED | `packages/workers/src/base/lifecycle.ts` `runLifecycle()` implements all 4 phases with PhaseGuardedHandle; LifecycleViolationError thrown on write() in Processing; unit tests in `src/__tests__/worker-lifecycle.test.ts` verify all bifurcation paths |
| 5 | Frontier Scheduler dispatches events with exact 5-term formula (base×10 + age_bonus≤20 + unlocks×5 + spawned_by_bonus(3) + active_bonus(15)) without LLM calls | VERIFIED | `packages/workers/src/scheduler/frontier.worker.ts` `FRONTIER_PRIORITY_SQL` and `dynamicScore()` implement exact formula; unit tests in `src/__tests__/frontier.test.ts` verify each term; no LLM import in the dispatch path |
| 6 | Context Assembly produces 3-layer prompt (Stable/Causal/Volatile) with Zero-LLM overflow discard at W_max | VERIFIED | `packages/workers/src/context/assemble.ts` assembles 3 layers; `packages/workers/src/context/overflow.ts` `ReverseChronologicalDiscarder` does Zero-LLM greedy discard; IOverflowStrategy reserved but not activated (correct per ADR 30) |
| 7 | Worker class fails to compile if it calls `write()` via a Tool context (TypeScript ABC enforcement, ADR 35) | VERIFIED | `packages/workers/src/base/read-only-handle.ts` `ReadOnlyGraphHandle` interface has no `write()` declaration; `@ts-expect-error` in `src/__tests__/tool-boundary.test.ts` proves tsc emits TS2339; `ReadOnlyGraphHandleImpl.write()` throws `SecurityException` at runtime — D4 is actually implemented (implementation notes are stale on this point) |
| 8 | canonical_json produces deterministic output regardless of insertion order (BTreeMap equivalent) | VERIFIED | `packages/shared/src/canonical-json.ts` `sortedValue()` recursively sorts keys via `Object.keys().sort()`; `hashablePayload()` strips `_meta` and `schema_version`; unit tests in `src/__tests__/canonical-json.test.ts` exist |
| 9 | Pattern discovery cron fires every 6 hours; skips if completed_scope_count < 10; does not acquire OLTP slots | VERIFIED | `packages/workers/src/patterns/discover.worker.ts` `PATTERN_DISCOVERY_CRON_TRIGGER` has expression `'0 0 */6 * * * *'`; `MIN_CORPUS_THRESHOLD=10` guard implemented; worker runs on iii cron (separate from OLTP pool); unit tests in `src/__tests__/pattern-discovery.test.ts` verify skip/run boundary |

**Score:** 9/9 truths verified

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `migrations/001-extensions.sql` | pgcrypto + pgvector extensions | VERIFIED | Idempotent `CREATE EXTENSION IF NOT EXISTS` for both |
| `migrations/002-event-log.sql` | `execution_event_log` PARTITION BY LIST, TEXT payload, typed columns | VERIFIED | Correct schema; payload is TEXT; typed Frontier columns present; CHECK constraint for 5 event types |
| `migrations/003-memory-tables.sql` | 4 memory tables with ts_doc, topology_embedding vector(128) HNSW | VERIFIED | All 4 tables; GIN indexes; HNSW partial index m=16, ef_construction=64 |
| `migrations/004-bus-state.sql` | bus_state for HWM | VERIFIED | File exists |
| `migrations/005-scope-lineage.sql` | scope_lineage cold metadata, depth CHECK ≤3 | VERIFIED | Present with status index and depth constraint |
| `packages/shared/src/canonical-json.ts` | BTreeMap-equivalent key sort, no external deps | VERIFIED | Pure TypeScript; recursive sort; exported `canonicalJson` and `hashablePayload` |
| `packages/shared/src/sql/occ-writable-cte.sql.ts` | OCC Writable CTE with causal inversion, partition-aware | VERIFIED | `OCC_WRITE_SQL(partition)` and `OCC_WRITE_DO_NOTHING_SQL(partition)` are functions accepting partition name; causal inversion implemented in DO UPDATE; `partitionTable()` helper present |
| `packages/shared/src/occ-write.ts` | `occWrite()` helper for Gateway/shared use | VERIFIED | Calls `OCC_WRITE_SQL(partitionTable(scopeId))` with 5 parameters including event_type |
| `packages/gateway/src/index.ts` | Hono app, 3 routes mounted | VERIFIED | `buildApp()` mounts scopes, events, scope-read routes under `/v1/scopes` |
| `packages/gateway/src/routes/scopes.ts` | POST /v1/scopes, Zod guard, nestScope delegation | VERIFIED | Delegates to `nestScope()`, assembles context, returns 201 |
| `packages/gateway/src/routes/events.ts` | POST /v1/scopes/:id/events, OCC write, inline Watchdog, context | VERIFIED | Suspended lockout (ADR 39), OCC write, convergence check, scope_closed write, context assembly |
| `packages/gateway/src/routes/scope-read.ts` | GET /v1/scopes/:id | VERIFIED | Returns scope_id, status, context |
| `packages/gateway/src/middleware/zod-guard.ts` | UUID v4 validation, 400 before DB | VERIFIED | `validateScopeIdParam()` returns 400 before any DB access |
| `packages/gateway/src/watchdog-sql.ts` | Inline Watchdog SQL, writeScopeClosed, writeContextOomThrottled | VERIFIED | All three functions present; writeContextOomThrottled uses status='suspended' (D6 fix applied) |
| `packages/control-plane/src/index.ts` | Boot: register iii worker, start pulse-fetch, instantiate watchdog | VERIFIED | Correct boot sequence |
| `packages/control-plane/src/pulse-fetch.ts` | pg-listen, HWM, replay, LISTEN/NOTIFY bridge | VERIFIED | Boot order: connect → listenTo → readHwm → replay; Gate 1 Control Plane showed `pulse.fetch subscribed hwm:0` |
| `packages/control-plane/src/watchdog.ts` | 3-tier ScopeConvergenceTracker, scope_closed emitter | VERIFIED | 3-tier in-memory + lock + DB SQL; checkAndClose emits scope_closed |
| `packages/control-plane/src/nesting.ts` | 3-phase DDL nesting in single transaction | VERIFIED | BEGIN/COMMIT wraps all 3 phases; ROLLBACK on failure |
| `packages/workers/src/index.ts` | 4 worker registrations | VERIFIED | graph::context-assembly, graph::conflict-resolver, graph::scheduler::frontier, graph::patterns::discover |
| `packages/workers/src/scheduler/frontier.worker.ts` | FrontierSchedulerWorker, exact SQL formula, token bucket | VERIFIED | FRONTIER_PRIORITY_SQL matches ADR 31 formula exactly; TokenBucket 50ms window |
| `packages/workers/src/queue/pg-queue-adapter.ts` | FOR UPDATE SKIP LOCKED dequeue, LISTEN wakeup | VERIFIED | Correct dequeue SQL; dedicated non-pooled Client for LISTEN |
| `packages/workers/src/base/read-only-handle.ts` | ReadOnlyGraphHandle (no write()), SecurityException runtime guard | VERIFIED | Interface has no write(); concrete impl throws SecurityException |
| `packages/workers/src/base/lifecycle.ts` | runLifecycle, PhaseGuardedHandle, LifecycleViolationError | VERIFIED | Full 4-phase driver; write() blocked during Processing |
| `packages/workers/src/context/assemble.ts` | 3-layer assembleContext, W_max budget, Zero-LLM discard | VERIFIED | Correct layer assembly; overflow discard via ReverseChronologicalDiscarder |
| `packages/workers/src/patterns/discover.worker.ts` | 6h cron trigger, MIN_CORPUS guard, base_priority=1 | VERIFIED | Cron expression and guard correct |
| `packages/shared/src/logger.ts` | pino structured logger, canonical LOG_EVENTS | VERIFIED | pino singleton with service tag; all expected LOG_EVENT constants present |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| Gateway events.ts | shared/occ-write.ts | `import { occWrite } from '@shared/occ-write'` | WIRED | Line 30 of events.ts; causal inversion path used for external agent writes |
| Gateway scopes.ts | control-plane/nesting.ts | `import { nestScope } from '@graph/control-plane/nesting'` | WIRED | Line 23 of scopes.ts; DDL nesting correctly delegated to CP |
| Gateway events.ts | watchdog-sql.ts | `import { checkConvergence, writeScopeClosed, writeContextOomThrottled }` | WIRED | Lines 35-37 of events.ts; inline Watchdog SQL wired |
| OCC SQL | partition table | `OCC_WRITE_SQL(partitionTable(scopeId))` | WIRED | fc0a6ae fix — no longer targeting parent table |
| Control Plane | pg-listen | `createSubscriber()` + `subscriber.listenTo(CHANNEL)` | WIRED | pulse-fetch.ts lines 40-50 |
| Control Plane | iii-sdk | `registerWorker()` + `iiiWorker.trigger()` | WIRED | control-plane/index.ts + pulse-fetch.ts |
| Workers index.ts | FrontierSchedulerWorker | `worker.registerFunction` + `worker.registerTrigger` | WIRED | index.ts lines 65-72 |
| Workers index.ts | PatternDiscoveryWorker | `worker.registerFunction` + `worker.registerTrigger` | WIRED | index.ts lines 75-79 |
| context/assemble.ts | context/knapsack.ts | `import { knapsackSlice }` | WIRED | assemble.ts line 19 |
| context/assemble.ts | shared/tokenizer.ts | `import { countTokens }` | WIRED | assemble.ts line 18 |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `gateway/routes/scopes.ts` | `planHash` | `nestScope()` → pgcrypto digest() inside DDL transaction | Yes — real DB hash | FLOWING |
| `gateway/routes/events.ts` | `version_hash, occ_result` | `occWrite()` → `OCC_WRITE_SQL` → pgcrypto in Writable CTE | Yes — DB-computed hash | FLOWING |
| `gateway/routes/events.ts` | assembled context | `assembleContext()` → `knapsackSlice()` → pool.query chain from event_log | Yes — real DB rows | FLOWING |
| `gateway/routes/scope-read.ts` | scope status, context | `scope_lineage` + `execution_event_log` queries | Yes — real DB rows | FLOWING |
| `workers/patterns/discover.worker.ts` | `count` | `SELECT count(*) FROM scope_lineage WHERE status = 'closed'` | Yes — real DB query | FLOWING |
| `workers/scheduler/frontier.worker.ts` | `frontierResult` | `FRONTIER_PRIORITY_SQL` against execution_event_log | Yes — real DB query | FLOWING |

---

### Behavioral Spot-Checks

Step 7b SKIPPED — project requires PostgreSQL + iii engine + Bun runtime to be running. Cannot run behavioral spot-checks without starting services. Gate 1 E2E results (provided by developer) serve as the behavioral evidence.

**Gate 1 E2E results (developer-reported, 2026-06-03):**

| Behavior | Expected | Result | Status |
|----------|----------|--------|--------|
| Scenario A: POST /v1/scopes | 201, scope_id + plan_hash, plan_created in DB, ZERO_HASH predecessor | Passed | PASS |
| Scenario A: pino scope.created log | scope_id field present | Passed | PASS |
| Scenario B: POST /v1/scopes/:id/events | 200, occ_result=won, hash chain connected | Passed | PASS |
| Scenario C: GET /v1/scopes/:id | 200, scope_id + status + context | Passed | PASS |
| Scenario D: Zod reject invalid UUID | 400, no DB access | Passed | PASS |
| Scenario E: OCC conflict | first=won, second=demoted, HTTP 200 | Passed | PASS |
| Control Plane pulse.fetch | subscribed hwm:0 | Passed | PASS |
| No ERROR/FATAL pino logs | Zero error-level entries | Passed | PASS |

---

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| REQ-01 | execution_event_log PARTITION BY LIST, UNIQUE(predecessor_hash, scope_id) per partition | SATISFIED | migrations/002-event-log.sql; constraints created per-partition in nesting.ts |
| REQ-02 | pgcrypto digest() inside Writable CTE, never ::jsonb | SATISFIED | OCC_WRITE_SQL uses pgcrypto; payload stored as TEXT |
| REQ-03 | canonical_json BTreeMap-equivalent key sort | SATISFIED | canonical-json.ts recursive sort |
| REQ-04 | 4 memory tables, ts_doc tsvector, topology_embedding vector(128) HNSW | SATISFIED | migrations/003-memory-tables.sql |
| REQ-05 | scope_lineage cold metadata table | SATISFIED | migrations/005-scope-lineage.sql |
| REQ-06 | Control Plane pg-listen, LISTEN/NOTIFY, HWM advance | SATISFIED | pulse-fetch.ts, hwm.ts |
| REQ-07 | 3-phase scope nesting in single DDL transaction | SATISFIED | nesting.ts BEGIN/COMMIT wrapping all 3 phases |
| REQ-08 | Convergence Watchdog 3-tier defense, only scope_closed emitter in CP | SATISFIED | watchdog.ts ScopeConvergenceTracker |
| REQ-09 | Context OOM 3-tier degradation chain | SATISFIED (partial) | Tier 1+2 are stubs (LLM distill + tail-truncate not active in Phase 1); Tier 3 implemented. Tier 1+2 are annotated stubs — acceptable for Phase 1 |
| REQ-10 | @dqbd/tiktoken Wasm tokenizer for W_max | SATISFIED | tokenizer.ts singleton; sub-1ms token count |
| REQ-11 | Workers have GraphHandle; Tools have ReadOnlyGraphHandle; TypeScript ABC | SATISFIED | read-only-handle.ts, graph-handle.ts; SecurityException at runtime |
| REQ-12 | Worker 4-phase lifecycle, Knapsack failure bifurcation | SATISFIED | lifecycle.ts runLifecycle; PhaseGuardedHandle |
| REQ-13 | Knowledge entity write timing: tool result written immediately (ON CONFLICT DO NOTHING) | SATISFIED | lifecycle.ts writeToolResult(); workers use occWriteIdempotent |
| REQ-14 | Subagent scope branching, MAX_CHILD_SCOPE_DEPTH=3 | SATISFIED | nesting.ts depth guard; scope_lineage depth CHECK ≤3; subagent.ts |
| REQ-15 | HTTP Gateway 3 endpoints | SATISFIED | gateway/index.ts mounts all 3 |
| REQ-16 | Zod validation, UUID v4 + hash regex, 400 before DB | SATISFIED | schemas.ts UUID_V4 + HASH_HEX64; zod-guard.ts |
| REQ-17 | PgQueueAdapter FOR UPDATE SKIP LOCKED | SATISFIED | pg-queue-adapter.ts DEQUEUE_SQL |
| REQ-18 | Idempotency UNIQUE(scope_id, entity_id, version_hash), ON CONFLICT DO NOTHING | SATISFIED | nesting.ts adds constraint per partition; occWriteIdempotent |
| REQ-19 | Frontier Scheduler Top-K SQL formula, token bucket, no LLM | SATISFIED | frontier.worker.ts FRONTIER_PRIORITY_SQL; dynamicScore() |
| REQ-20 | 3-layer context assembly, Zero-LLM overflow, IOverflowStrategy reserved | SATISFIED | assemble.ts + overflow.ts; IOverflowStrategy declared but not activated |
| REQ-21 | LLMProvider/EmbeddingProvider interfaces, OpenAI-compatible provider | SATISFIED (deviation D3) | Interfaces in workers package instead of shared — DOCUMENTED, deferred Phase 2 |
| REQ-22 | Pattern discovery 6h cron, MIN_CORPUS guard, no OLTP slots | SATISFIED | discover.worker.ts |
| REQ-23 | Scope UUID orthogonal to context window size | SATISFIED | ReadOnlyGraphHandle scopeId never mutated; test in tool-boundary.test.ts |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `packages/control-plane/src/watchdog.ts` | 196 | `'terminated'` used as status for OOM event (should be `'suspended'` per ADR 38 / D6 fix) | WARNING | D6 fix was applied to `watchdog-sql.ts` (Gateway path) but the Control Plane Watchdog's `handleContextOom()` tier-3 path still uses `'terminated'`. This is inconsistent: a CP-triggered OOM would allow the Watchdog to close the scope as converged (because the scope_lineage IS updated to `'suspended'` in line 207, but the event row has `status='terminated'` which is excluded by CONVERGENCE_SQL). The scope_lineage update does protect the Watchdog SQL, so behaviour may be correct. Needs architect verification. |
| `packages/workers/src/base/graph-handle.ts` | 69–123 | Local `occWrite` uses `ON CONFLICT DO NOTHING` semantics (not causal inversion) | WARNING | Worker-level writes use a different OCC variant than Gateway writes. Workers see `occ_result='won' or 'demoted'` but the 'demoted' path via DO NOTHING returns 'demoted' only by detecting 0 rows inserted. The causal inversion (conflict_detected event) does NOT occur for Worker internal writes. This may be intentional (Workers are trusted actors; only external agent writes need causal inversion) but requires architect sign-off. |
| `packages/workers/src/concrete/conflict-resolver.worker.ts` | 17–33 | ConflictResolverWorker is a no-op stub | INFO | Phase 1 design: OCC Writable CTE handles conflicts deterministically. LLM-assisted merge deferred to Phase 2. Documented. |
| `packages/control-plane/src/watchdog.ts` | 165–166 | OOM tier-1 (LLM distillation) and tier-2 (tail truncation) are stubs | INFO | REQ-09 only requires Tier 3 for Phase 1 (DB write). Tiers 1+2 are annotated stubs. Acceptable. |

**No TBD, FIXME, or XXX markers found in Phase 1 files.**

---

### Human Verification Required

#### 1. Control Plane Watchdog OOM Status Consistency

**Test:** In `packages/control-plane/src/watchdog.ts`, line 196: check whether the status value for the OOM event INSERT should be `'suspended'` (matching `watchdog-sql.ts`) or whether `'terminated'` is intentional because the `scope_lineage` UPDATE to `'suspended'` already blocks the Watchdog query path.

**Expected:** Either (a) `watchdog.ts` line 196 is corrected to `'suspended'` to match `watchdog-sql.ts` and the ADR 38 fix, or (b) the architect documents why `'terminated'` is correct for the CP path while `'suspended'` is correct for the Gateway path.

**Why human:** The CONVERGENCE_SQL excludes `status NOT IN ('terminated', 'archived')`, meaning a `'terminated'` OOM event WOULD satisfy convergence (it is excluded from pending count). But the `scope_lineage` is also updated to `'suspended'`, and the suspended lockout in the Gateway checks `scope_lineage.status` — so OOM scopes are still protected from new writes. Whether this makes the `'terminated'` status correct or a latent bug requires architect judgment.

#### 2. Worker-Level OCC Variant Confirmation

**Test:** Confirm that `packages/workers/src/base/graph-handle.ts` local `occWrite` (DO NOTHING) vs `packages/shared/src/occ-write.ts` (causal inversion) split is the intended architecture. Workers use the former; the Gateway uses the latter.

**Expected:** ADR 11 specifies which actors should receive causal inversion. If Workers are trusted actors that should use DO NOTHING (idempotent re-delivery), confirm. If Workers should also receive causal inversion, the import in `graph-handle.ts` needs to be updated to use the shared `occWrite`.

**Why human:** This is an architectural decision that cannot be resolved from static analysis of the code alone.

#### 3. Nesting Index (event_id Column)

**Test:** After running Scenario A (POST /scopes), query PostgreSQL:
```sql
SELECT indexname FROM pg_indexes WHERE tablename LIKE 'execution_event_log_scope_%';
```
Confirm `idx_scope_<nodash>_pending_lookup` exists and was created without error.

**Expected:** Index was created successfully, confirming `event_id` is a valid column (present in migration 002 as BIGINT) and the index creation succeeds at runtime.

**Why human:** Gate 1 passed (Scenario A returned 201), but the CREATE INDEX statement in `nesting.ts` line 103 includes `event_id ASC` — static analysis cannot fully substitute for seeing the actual DB state.

---

### Deviations Summary

| Deviation | Status | Notes |
|-----------|--------|-------|
| D1: event_type always 'memory_updated' | RESOLVED | ADR 40 fix; OCC_WRITE_SQL now accepts $5 event_type parameter; task_spawned is first-class |
| D3: LLMProvider/EmbeddingProvider in workers package | DEFERRED Phase 2 | Documented in implementation-notes.md; Phase 2 Day 0 migration planned |
| D4: Tool write() guard compile-time only | ACTUALLY RESOLVED | Implementation notes claim deferred, but `SecurityException` IS implemented in `read-only-handle.ts` line 38+71; runtime guard is active. Notes are stale. |
| D6: context_oom_throttled status | PARTIALLY RESOLVED | Gateway `watchdog-sql.ts` uses `'suspended'` (correct). Control Plane `watchdog.ts` line 196 still uses `'terminated'`. Needs human verification (item 1 above). |
| G1-Fix-1: OCC partition bug | FIXED | `fc0a6ae` — INSERT now targets per-scope partition via `partitionTable(scopeId)` function |
| G1-Obs-1: Gateway requires Bun runtime | DOCUMENTED | `export default { port, fetch }` is Bun server API; Gate 1 used Bun 1.3.14 |
| G1-Obs-2: OCC conflict causal inversion behaviour | DOCUMENTED | DO UPDATE rewrites winner's event_type to conflict_detected (causal inversion as designed) |

---

### Gaps Summary

No blocking gaps. All 9 success criteria are observable in the codebase and verified against the actual code. The three human verification items are architectural questions or runtime state confirmations, not missing implementations.

The `watchdog.ts` status inconsistency (WARNING above) is the most significant open question, but it does not block Phase 1 completion because: (a) Gate 1 E2E passed without exercising the OOM tier-3 path in the Control Plane, (b) the `scope_lineage` UPDATE to `'suspended'` protects the suspended lockout path regardless of the event row status, and (c) the discrepancy is isolated to the Control Plane's `handleContextOom()` method which is not part of any Gate 1 scenario.

---

_Verified: 2026-06-03T05:30:00Z_
_Verifier: Claude (gsd-verifier)_
