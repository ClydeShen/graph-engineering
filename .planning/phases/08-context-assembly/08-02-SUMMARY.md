---
phase: 08-context-assembly
plan: 02
subsystem: workers
tags: [typescript, vitest, worker-lifecycle, pipeline-hooks]

# Dependency graph
requires:
  - phase: 07-context-assembly-scaffold
    provides: Worker abstract class with ADR-27 lifecycle hooks (onScheduled/onRunning/onCompleted/onFailed/onConflicted)
provides:
  - PipelineContext interface (D-07): scopeId, wMax, tokensBefore, tokensAfter, ccrHashes (readonly), droppedCount
  - 4 protected no-op pipeline hooks on Worker: onContextAssembled, onContextCompressed, onLLMCalled, onResultWritten (D-06, D-13)
affects: [08-context-assembly plan 03 (CCR + assemble.ts wiring), 09-reflection-track]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Two-layer Worker hook contract: abstract ADR-27 lifecycle hooks (state machine, lifecycle.ts-driven) vs protected no-op Phase 08 pipeline observability hooks (assembly-path-driven)"
    - "Readonly<PipelineContext> with readonly string[] for ccrHashes — compile-time mutation guard (T-08-03)"

key-files:
  created:
    - packages/workers/src/base/worker.abstract.test.ts
  modified:
    - packages/workers/src/base/worker.abstract.ts

key-decisions:
  - "PipelineContext co-located in worker.abstract.ts (alongside the hooks that consume it), following the AssembledContext-co-located-with-assembleContext precedent"
  - "Hook parameters typed Readonly<PipelineContext> with ccrHashes: readonly string[] per D-07 read-only contract"

patterns-established:
  - "Pipeline observability hooks added as protected non-abstract no-op methods on Worker — subclasses opt in by overriding, no forced implementation (headroom CompressionHooks pattern)"

requirements-completed: []

# Metrics
duration: 15min
completed: 2026-06-10
---

# Phase 8 Plan 2: Pipeline Lifecycle Hooks Summary

**Added `PipelineContext` type and 4 no-op protected pipeline observability hooks (`onContextAssembled`, `onContextCompressed`, `onLLMCalled`, `onResultWritten`) to the `Worker` abstract class, implementing D-06/D-07/D-08/D-13.**

## Performance

- **Duration:** ~15 min
- **Completed:** 2026-06-10T10:02:29Z
- **Tasks:** 1
- **Files modified:** 2 (1 modified, 1 created)

## Accomplishments
- `PipelineContext` interface added with the exact D-07 fields (`scopeId`, `wMax`, `tokensBefore`, `tokensAfter`, `ccrHashes: readonly string[]`, `droppedCount`)
- 4 protected `async` no-op hooks added to `Worker`, distinct from the 5 existing `abstract` ADR-27 lifecycle hooks
- Hooks typed `Readonly<PipelineContext>` per D-07's read-only contract (T-08-03 mitigation)
- Class-level JSDoc documents the two hook layers (ADR-27 lifecycle state machine vs Phase 08 pipeline observability)
- 4 passing unit tests proving non-abstract defaults, no-op resolution to `undefined`, override capability, and `PipelineContext` shape compile-correctness

## Task Commits

Each task was committed atomically:

1. **Task 1: PipelineContext type + 4 no-op pipeline hooks on Worker** - `2896d9ab` (feat)

**Plan metadata:** (this commit, see below)

## Files Created/Modified
- `packages/workers/src/base/worker.abstract.ts` - Added `PipelineContext` interface and 4 protected no-op pipeline hooks (`onContextAssembled`, `onContextCompressed`, `onLLMCalled`, `onResultWritten`), plus class-level JSDoc distinguishing the two hook layers
- `packages/workers/src/base/worker.abstract.test.ts` - New test file: 4 tests covering non-abstract defaults, no-op resolution, override capability, and `PipelineContext` type shape

## Decisions Made
- `PipelineContext` lives in `worker.abstract.ts` co-located with the hooks (matches `AssembledContext`/`assemble.ts` precedent) rather than a separate `pipeline-context.ts` file
- Existing `WorkerExecutionContext`, the 5 existing `abstract` methods, and `lifecycle.ts` were left untouched per D-08 — these hooks are not called from `runLifecycle()`

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

Pre-existing, out-of-scope test failures observed when running the full `packages/workers` test suite (`npx vitest run`): 8 test files fail with `Failed to load url @graph/types/api ... in packages/shared/src/types.ts`. This is a module-resolution issue unrelated to `worker.abstract.ts` and not caused by this plan's changes. The target test (`worker.abstract.test.ts`) passes 4/4, and `npx tsc --noEmit` for `packages/workers` is clean. Logged in `.planning/phases/08-context-assembly/deferred-items.md`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

`PipelineContext` shape is ready for Plan 03 (CCR + assemble.ts wiring) to populate and pass to these hooks via a Worker's `onRunning()`. No blockers.

---
*Phase: 08-context-assembly*
*Completed: 2026-06-10*

## Self-Check: PASSED

- FOUND: packages/workers/src/base/worker.abstract.ts
- FOUND: packages/workers/src/base/worker.abstract.test.ts
- FOUND: .planning/phases/08-context-assembly/08-02-SUMMARY.md
- FOUND: commit 2896d9ab
