---
phase: 09-memory-layers
plan: "01"
subsystem: memory-layers
tags: [migration, memory-repository, trail-reader, worker-abstract, episodic, semantic, procedural, hnsw, adr-43]
dependency_graph:
  requires: []
  provides:
    - migrations/012-memory-embedding.sql
    - MemoryRepository.appendEpisodicSummary
    - MemoryRepository.insertSemanticFact (v2 with embedding + suggestedMerge)
    - MemoryRepository.supersede
    - ProceduralTemplateParams.isAntiPattern
    - TrailReader.getScopeEvents
    - Worker.shouldReflect
  affects:
    - packages/workers/src/memory/semantic.worker.ts (stub embedding [] pending Plan 03)
    - packages/workers/src/base/lifecycle.ts (PhaseGuardedHandle.getScopeEvents delegation)
    - src/__tests__/worker-lifecycle.test.ts (mock updated)
tech_stack:
  added: []
  patterns:
    - Writable CTE with LEFT JOIN for insertSemanticFact similarity hint
    - HNSW partial indexes (episodic: WHERE embedding IS NOT NULL; procedural negative: WHERE is_anti_pattern = TRUE)
    - ADR-43 source_scope_id provenance column on all three memory tables
key_files:
  created:
    - migrations/012-memory-embedding.sql
  modified:
    - packages/workers/src/base/memory-repository.ts
    - packages/workers/src/base/trail-reader.ts
    - packages/workers/src/base/worker.abstract.ts
    - packages/workers/src/base/lifecycle.ts
    - packages/workers/src/memory/semantic.worker.ts
    - src/__tests__/worker-lifecycle.test.ts
decisions:
  - "source_scope_id = $1 (scope_id reused) in all three memory table INSERTs — no extra parameter needed"
  - "erased_at TIMESTAMPTZ NULL — nullable; only set by Phase 14 erase workflow"
  - "insertSemanticFact uses writable CTE to atomically insert + find similar in one round-trip"
  - "getScopeEvents cascades to PhaseGuardedHandle and test mocks because GraphHandle extends TrailReader"
  - "semantic.worker.ts stubbed with [] embedding — Plan 03 replaces with real EmbeddingProvider.embed()"
  - "idempotency.test.ts TS2459 error is pre-existing from ce6f64b9 dead-code sprint; not caused by this plan"
metrics:
  duration_minutes: 7
  completed_date: "2026-06-11"
  tasks_completed: 3
  files_modified: 6
  files_created: 1
---

# Phase 9 Plan 01: Foundation Seams Summary

**One-liner:** DB migration 012 (episodic embedding + negative procedural HNSW + ADR-43 provenance), MemoryRepository seam extensions (appendEpisodicSummary, insertSemanticFact v2 with HNSW similarity hint, supersede, isAntiPattern), TrailReader.getScopeEvents, and Worker.shouldReflect opt-out hook.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Migration 012 — episodic embedding + negative HNSW | 6a58c094 | migrations/012-memory-embedding.sql |
| 2 | MemoryRepository seam extensions | 471c386f | packages/workers/src/base/memory-repository.ts, packages/workers/src/memory/semantic.worker.ts |
| 3 | TrailReader.getScopeEvents + Worker.shouldReflect | 33b5315d | packages/workers/src/base/trail-reader.ts, packages/workers/src/base/worker.abstract.ts, packages/workers/src/base/lifecycle.ts, src/__tests__/worker-lifecycle.test.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] semantic.worker.ts broken by insertSemanticFact signature change**
- **Found during:** Task 2
- **Issue:** Changing `insertSemanticFact` from 2-arg to 3-arg (adding `embedding`) broke the existing caller in `semantic.worker.ts` (TS2554: Expected 3 arguments, but got 2)
- **Fix:** Added `[]` as stub embedding with TODO comment; Plan 03 will replace with `EmbeddingProvider.embed()`
- **Files modified:** packages/workers/src/memory/semantic.worker.ts
- **Commit:** 471c386f

**2. [Rule 3 - Blocking] PhaseGuardedHandle + worker-lifecycle.test.ts broken by getScopeEvents addition**
- **Found during:** Task 3
- **Issue:** Adding `getScopeEvents` to `TrailReader` cascaded to `GraphHandle` (which extends `TrailReader`). `PhaseGuardedHandle implements GraphHandle` was missing the method, and the inline mock object in `worker-lifecycle.test.ts` was also missing it.
- **Fix:** Added `getScopeEvents` delegation to `PhaseGuardedHandle`; added `getScopeEvents: vi.fn().mockResolvedValue([])` to the test mock
- **Files modified:** packages/workers/src/base/lifecycle.ts, src/__tests__/worker-lifecycle.test.ts
- **Commit:** 33b5315d

### Pre-existing Issues (not caused by this plan)

- `tests/integration/idempotency.test.ts(14,20): error TS2459` — `occWriteIdempotent` was unexported in commit `ce6f64b9` (dead-code sprint) but the test still imports it. Pre-existing; out of scope.

## Key Decisions

1. **source_scope_id reuses $1** — the `scope_id` parameter itself is the provenance source per ADR-43-D4. No extra query parameter needed.
2. **Writable CTE for insertSemanticFact** — atomic: inserts new semantic fact AND finds nearest neighbor (cosine > 0.89) in a single DB round-trip. Returns `{ id, suggestedMerge }` — caller decides whether to supersede.
3. **erased_at is nullable** — existing rows predate ADR-43 and stay NULL. Phase 14 erase workflow sets it during crypto-shredding.
4. **isAntiPattern optional with default false** — existing callers (`ProceduralMemoryWorker`) don't need to change their call sites.
5. **Worker.shouldReflect() is public** — not protected, so `runContextAssemblyPipeline` can call it without type-casting. Plan 04 uses it directly on the Worker type.

## Known Stubs

- `semantic.worker.ts` line ~31: `insertSemanticFact(scopeId, writeGuard(fact), [])` — embedding is `[]` (empty array). This stub prevents the SemanticMemoryWorker from actually computing HNSW similarity. Plan 03 replaces this with `EmbeddingProvider.embed()` call.

## Threat Flags

None — no new network endpoints or auth paths introduced. SQL uses parameterized queries throughout.

## Self-Check: PASSED

All files exist and all task commits are present in the repository.
