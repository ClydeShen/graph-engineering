---
phase: 09-memory-layers
plan: 03
subsystem: memory
tags: [vitest, typescript, semantic-memory, embeddings, supersession, hnsw]

# Dependency graph
requires:
  - phase: 09-memory-layers
    provides: "09-01 — updated SemanticRepository interface (insertSemanticFact returns suggestedMerge, supersede method) and StubMemoryRepository.setSuggestedMergeResult"
provides:
  - "SemanticMemoryWorker with EmbeddingProvider constructor param (5th arg)"
  - "Caller-computed embedding flow: embed.embed(writeGuard(fact)) -> insertSemanticFact(scopeId, content, vector)"
  - "Explicit supersession branching: supersede(suggestedMerge.id, id) only when suggestedMerge !== null (D-08, no auto-supersede)"
  - "Full test coverage for supersession path, no-supersession path, embed wiring, and empty-records early return"
affects: [09-04, context-assembly-phase, hnsw-retrieval]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Caller-owns-embedding: Workers compute embeddings via EmbeddingProvider.embed() and pass vectors into repository methods rather than repository computing them internally"
    - "Explicit supersession decision: repository surfaces a suggestedMerge hint, caller (Worker) decides whether to call supersede() — no implicit DB-side merging"

key-files:
  created: []
  modified:
    - packages/workers/src/memory/semantic.worker.ts
    - packages/workers/src/memory/semantic.worker.test.ts

key-decisions:
  - "No auto-supersede: SemanticMemoryWorker only calls memory.supersede() when insertSemanticFact returns a non-null suggestedMerge, per D-08"
  - "Embedding call placed after LLM distillation, before insertSemanticFact, with writeGuard applied to both the LLM input and the embed input (T-09-03-01 mitigation)"

patterns-established:
  - "EmbeddingProvider mock factory (makeEmbed) returning { vector: Array(1536).fill(0.1), countedAgainstBudget: false } — reusable pattern for any worker test requiring embeddings"

requirements-completed: [D-06, D-07, D-08, D-09]

# Metrics
duration: ~10min (continuation session; Task 1 completed in prior session)
completed: 2026-06-11
---

# Phase 09 Plan 03: SemanticMemoryWorker Supersession Summary

**SemanticMemoryWorker now pre-computes embeddings via EmbeddingProvider and explicitly supersedes prior semantic facts only when the repository signals a similarity match (D-06/D-07/D-08).**

## Performance

- **Duration:** ~10 min (this continuation session; Task 1 was completed and committed in a prior session)
- **Started:** 2026-06-11T15:16:11+12:00 (Task 1 commit timestamp)
- **Completed:** 2026-06-11
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- SemanticMemoryWorker constructor extended to 5 parameters (reader, memory, writes, llm, embed)
- Worker computes an embedding for the LLM-distilled fact via `embed.embed(writeGuard(fact))` and passes the resulting vector to `insertSemanticFact(scopeId, writeGuard(fact), vector)`
- Explicit supersession branch: `if (suggestedMerge !== null) { await this.memory.supersede(suggestedMerge.id, id) }` — no auto-supersede when null (D-08)
- Full test suite covering: existing behaviors with updated 5-arg constructor, supersession-triggered path, no-supersession path, embed input/output wiring, and empty-records early return
- SEMANTIC_TRIGGER_CONFIG (topic `graph::scope::closed`, function_id `graph::memory::semantic`) unchanged

## Task Commits

Each task was committed atomically:

1. **Task 1: SemanticMemoryWorker — add EmbeddingProvider param + supersession logic** - `fdf53880` (feat)
2. **Task 2: SemanticMemoryWorker tests — supersession path coverage** - `395c000b` (test)

**Plan metadata:** (this commit) `docs(09-03): complete SemanticMemoryWorker supersession plan summary`

## Files Created/Modified
- `packages/workers/src/memory/semantic.worker.ts` - Added `EmbeddingProvider` import and constructor param; added embed step (`const { vector } = await this.embed.embed(writeGuard(fact))`); replaced `insertSemanticFact` call to pass `vector` and destructure `{ id, suggestedMerge }`; added supersession branch calling `memory.supersede(suggestedMerge.id, id)` only when `suggestedMerge !== null`
- `packages/workers/src/memory/semantic.worker.test.ts` - Added `makeEmbed()` mock factory; updated all `SemanticMemoryWorker` constructor calls to pass `embed` as 5th arg; added 4 new tests (supersede called with suggestedMerge, supersede not called when null, embed.embed called with writeGuard(fact), embedding vector forwarded to insertSemanticFact)

## Decisions Made
- Followed the plan's exact construction order: LLM distillation → embed (writeGuard applied) → insertSemanticFact(scopeId, writeGuard(fact), vector) → conditional supersede. No deviation from the D-06/D-07/D-08 design as specified in 09-CONTEXT.md and 09-01-SUMMARY.md.

## Deviations from Plan

None - plan executed exactly as written. Task 1 (implementation) was completed in a prior session (commit `fdf53880`) and verified compatible with this session's Task 2 work; no changes were needed to the implementation.

## Issues Encountered
- `npm run typecheck` reports 3 pre-existing TypeScript errors in `packages/workers/src/memory/template-proposal.worker.test.ts` (CanonicalEventType literal mismatches and an Array.find overload error). These originate from Plan 02 (commit `bc899947`, merged into this branch prior to Plan 03 starting) and are unrelated to `semantic.worker.ts`/`semantic.worker.test.ts` — out of scope per the plan's `files_modified` list and CLAUDE.md surgical-changes rule. Already documented in `.planning/phases/09-memory-layers/deferred-items.md` by the prior session. No new errors were introduced by Plan 03's changes; `semantic.worker.ts` and `semantic.worker.test.ts` produce zero typecheck errors and all 9 tests in `semantic.worker.test.ts` pass.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- SemanticMemoryWorker is ready for integration with the HNSW retrieval path (Phase 09 Plan 04 / context-assembly phase) — embeddings are now persisted alongside semantic facts and supersession chains are maintained.
- Pre-existing typecheck errors in `template-proposal.worker.test.ts` (Plan 02 origin) remain deferred and should be addressed in a future plan that touches that file — see `.planning/phases/09-memory-layers/deferred-items.md`.

---
*Phase: 09-memory-layers*
*Completed: 2026-06-11*

## Self-Check: PASSED

- FOUND: .planning/phases/09-memory-layers/09-03-SUMMARY.md
- FOUND: fdf53880 (Task 1 commit)
- FOUND: 395c000b (Task 2 commit)
