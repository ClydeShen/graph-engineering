---
phase: 05-architecture-hardening
plan: 06
subsystem: workers
tags: [crystallize, lessons, delta-prompt, sha256, procedural-memory, llm]

# Dependency graph
requires:
  - phase: 05-architecture-hardening-05
    provides: CrystallizeWorker with notify() wired (baseline for surgical modification)
  - phase: 04-external-integrations
    provides: procedural_memory table schema with fingerprint_id and content columns
provides:
  - "CrystallizeWorker with existing-lesson lookup before LLM call"
  - "Conditional delta prompt: delta path when lesson exists, full path when none"
  - "SHA-256 fingerprintId computed from combined trail content (node:crypto)"
affects: [lesson-save.worker, crystallize.worker, delta-crystallization]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "node:crypto SHA-256 for application-level fingerprint IDs (established by lesson-save.worker)"
    - "mockResolvedValueOnce chaining in pool mocks to isolate episodic vs procedural_memory queries"

key-files:
  created: []
  modified:
    - packages/workers/src/memory/crystallize.worker.ts
    - packages/workers/src/memory/crystallize.worker.test.ts

key-decisions:
  - "makePool helper updated to return empty rows on second call so pre-existing writeGuard test passes cleanly with no modification to existing it() blocks"
  - "fingerprintId computed from combined trail content (same pattern as lesson-save.worker.ts) — not a pgcrypto violation; ADR 02 applies only to the OCC version_hash chain inside Writable CTE"
  - "Conditional delta prompt: system message and user message both branch on existing lesson presence"

patterns-established:
  - "Delta crystallization: look up procedural_memory by fingerprintId before LLM call, inject EXISTING LESSON content to reduce rewrite cost on re-crystallization"

requirements-completed: [ARCH-06]

# Metrics
duration: 15min
completed: 2026-06-09
---

# Phase 05 Plan 06: CrystallizeWorker Delta Prompt Summary

**SHA-256 fingerprint lookup against procedural_memory injects existing lesson into LLM prompt, enabling delta-only output on re-crystallization instead of full rewrites**

## Performance

- **Duration:** 15 min
- **Started:** 2026-06-09T23:27:00Z
- **Completed:** 2026-06-09T23:42:00Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments

- Added `node:crypto` SHA-256 fingerprint computation from combined trail content before the LLM call
- Added `procedural_memory` SELECT using the computed fingerprint to check for an existing lesson
- Replaced static LLM prompt with conditional delta/full variant based on whether an existing lesson was found
- Updated LLM CALL annotation to reflect delta crystallization purpose
- Added two new test cases covering the delta path and the full path; zero pre-existing tests modified

## Task Commits

1. **Task 1: Existing-lesson lookup + conditional delta prompt** - `a2142b0b` (feat)

## Files Created/Modified

- `packages/workers/src/memory/crystallize.worker.ts` - Added createHash import, fingerprintId computation, procedural_memory SELECT, conditional delta/full LLM prompt
- `packages/workers/src/memory/crystallize.worker.test.ts` - Updated makePool helper, added two new it() blocks for delta and full paths

## Decisions Made

- `makePool` test helper updated to use `mockResolvedValueOnce` for the first call (episodic_memory) and `mockResolvedValue({rows:[]})` as default for subsequent calls (procedural_memory). This ensures pre-existing test cases receive empty rows for the procedural_memory lookup without modifying any `it()` block. The change is to a test utility, not a test case.
- `node:crypto` chosen for fingerprintId per established precedent in `lesson-save.worker.ts`. The pgcrypto constraint in CLAUDE.md applies only to the OCC `version_hash` chain inside a Writable CTE (ADR 02). Application-level fingerprint IDs are application code, not database OCC.
- Both prompt branches (`system` and `user` messages) are conditional on `existing !== null`. The user message uses `writeGuard()` in both branches, consistent with the existing security pattern.

## Deviations from Plan

None - plan executed exactly as written.

The only implicit decision was updating `makePool` (a test helper, not a test case) to prevent the existing `writeGuard` assertion from breaking due to the new second pool.query call. This is consistent with the plan constraint ("do not modify or rename any pre-existing test cases") — helper functions are not test cases.

## Issues Encountered

Pre-existing `tsc --noEmit` error in `packages/shared/src/types.ts` (Cannot find module `@graph/types/api`) was present before this change and is unrelated to this plan. Zero new TypeScript errors introduced.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Delta crystallization is now live: re-crystallization of a scope that produced a prior lesson will inject the existing lesson and request only the delta
- The `fingerprintId` computed here (SHA-256 of combined episodic content) is the same fingerprint used by `lesson-save.worker.ts` — they operate on the same `procedural_memory` rows
- All 5 tests pass (3 pre-existing + 2 new). tsc clean except pre-existing `@graph/types` error.

---
*Phase: 05-architecture-hardening*
*Completed: 2026-06-09*
