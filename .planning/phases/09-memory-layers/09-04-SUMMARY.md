---
phase: 09-memory-layers
plan: "04"
subsystem: memory-layers
tags: [reflection-track, mem-reflect, bm25-rrf, hnsw, cold-start, context-assembly, adr-21, adr-20]

# Dependency graph
requires:
  - phase: 09-memory-layers
    provides: "09-01 (MemoryRepository seam, TrailReader.getScopeEvents, Worker.shouldReflect), 09-02 (TemplateProposalWorker), 09-03 (SemanticMemoryWorker embeddingProvider + supersede)"
provides:
  - "memReflect pure function (BM25+HNSW RRF hybrid search, sequential greedy truncation)"
  - "MemReflectInput/MemReflectOutput types + computeReflectBudget"
  - "mem::reflect registered as iii Function in packages/workers/src/index.ts"
  - "AssembledContext.reflectionContent/reflectionTokens + opts.memReflect cold_start branch in runContextAssemblyPipeline"
  - "processAgentTurn production cold_start wiring (embeddingProvider 5th param)"
  - "TemplateProposalWorker registered on graph::scope::closed (replaces EpisodicMemoryWorker)"
affects: [phase-10-trail-discovery, gateway, control-plane]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Sequential greedy truncation across memory tiers (Procedural -> Episodic -> Semantic) within a trigger-type token budget (ADR-21)"
    - "BM25+HNSW RRF hybrid search per table: K=60, weights 0.6/0.4, missing-flow penalty rank=21, plainto_tsquery('english', ...) matching ts_doc GIN index"
    - "cold_start opt-out hook: Worker.shouldReflect() + hasEpisodic(scopeId) gate before mem::reflect injection"

key-files:
  created:
    - packages/workers/src/memory/reflect.function.ts
    - packages/workers/src/memory/reflect.function.test.ts
  modified:
    - packages/workers/src/context/assemble.ts
    - packages/workers/src/index.ts
    - packages/gateway/src/process-agent-turn.ts
    - packages/gateway/src/routes/events.ts
    - packages/gateway/src/index.ts
    - packages/control-plane/src/pulse-fetch.ts
    - packages/workers/src/memory/gate3.integration.test.ts

key-decisions:
  - "formatProcedural always includes the (possibly summary-truncated) entry even if it alone exceeds the remaining budget — matches ADR-21's intent (protect against extreme cases) and lets downstream tiers correctly observe a fully-consumed budget"
  - "BM25 queries use plainto_tsquery('english', ...) per migrations 003/006 accepted tradeoff, not the 'simple' config shown in ADR-20-supplement's Phase-1 schema sketch — existing ts_doc columns are GENERATED with to_tsvector('english', ...)"
  - "buildEventsRoute/buildApp thread embeddingProvider (gatewayLlmProvider, an OpenAICompatibleProvider) through to processAgentTurn for production cold_start wiring"
  - "Removed obsolete G3-1 integration test (EpisodicMemoryWorker.onEvent) — subject deleted per D-01; TPW's episodic write path already covered by template-proposal.worker.test.ts"

patterns-established:
  - "iii Function registration without registerTrigger: mem::reflect is invoked directly via worker.trigger() / runContextAssemblyPipeline opts.memReflect.fn, not topic-subscribed"

requirements-completed: [D-01, D-10, D-11, D-12]

# Metrics
duration: ~25min
completed: 2026-06-11
---

# Phase 9 Plan 04: Reflection Track Wiring Summary

**memReflect implements ADR-21 sequential greedy truncation (Procedural->Episodic->Semantic) with BM25+HNSW RRF hybrid search; cold_start injection wired into runContextAssemblyPipeline and processAgentTurn; EpisodicMemoryWorker fully replaced by TemplateProposalWorker.**

## Performance

- **Duration:** ~25 min
- **Tasks:** 3
- **Files modified:** 9 (2 created, 7 modified, 2 deleted)

## Accomplishments
- `reflect.function.ts`: `memReflect`, `MemReflectInput`/`MemReflectOutput`, `computeReflectBudget`, three private `hybridSearch{Procedural,Episodic,Semantic}` functions implementing the ADR-20-supplement RRF CTE template (K=60, weights 0.6/0.4, missing-flow penalty rank=21)
- `assemble.ts`: `AssembledContext.reflectionContent`/`reflectionTokens` fields; `runContextAssemblyPipeline` gains `opts.memReflect = { fn, hasEpisodic }` and fires `mem::reflect` with `trigger_type: 'cold_start'` when `worker.shouldReflect()` is true and no episodic records exist
- `index.ts`: `EpisodicMemoryWorker`/`EPISODIC_TRIGGER_CONFIG` fully removed; `TemplateProposalWorker` registered on `graph::scope::closed`; `mem::reflect` registered as an iii Function (no trigger subscription — invoked directly)
- `process-agent-turn.ts`: `processAgentTurn` gains `embeddingProvider: EmbeddingProvider` as 5th param; production cold_start detection queries `episodic_memory` count for the scope and calls `memReflect` when count = 0, populating `context.reflectionContent`/`reflectionTokens`
- `pulse-fetch.ts`: dead `graph::memory::episodic` trigger block (and `isEpisodicSelf` self-write-loop guard) removed (D-01)
- `episodic.worker.ts` + `episodic.worker.test.ts` deleted

## Task Commits

Each task was committed atomically:

1. **Task 1: reflect.function.ts — memReflect pure function with RRF hybrid search** - `5c8324d0` (feat)
2. **Task 2: assemble.ts cold_start opts + index.ts full wiring** - `3ffe7f42` (feat)
3. **Task 3: reflect.function.test.ts — unit tests for memReflect and computeReflectBudget** - `7bbf155b` (test)

_Note: Task 3 also includes a one-line fix to `formatProcedural` (committed in the same `test` commit) discovered while writing the budget-exhaustion test — see Deviations below._

## Files Created/Modified
- `packages/workers/src/memory/reflect.function.ts` - `memReflect`, `MemReflectInput`/`MemReflectOutput`, `computeReflectBudget`, hybrid RRF search + format helpers for all three memory tiers
- `packages/workers/src/memory/reflect.function.test.ts` - 5 unit tests: budget arithmetic (cold_start/conflict_detected), empty-DB-result path, budget exhaustion, embed-call-count == 1
- `packages/workers/src/context/assemble.ts` - `AssembledContext.reflectionContent`/`reflectionTokens`; `runContextAssemblyPipeline` `opts.memReflect` cold_start branch
- `packages/workers/src/index.ts` - removed `EpisodicMemoryWorker` import + registration; added `TemplateProposalWorker` registration on `graph::scope::closed`; added `mem::reflect` iii Function registration
- `packages/gateway/src/process-agent-turn.ts` - `embeddingProvider` 5th param; cold_start episodic-count check + `memReflect` call
- `packages/gateway/src/routes/events.ts` - `buildEventsRoute` gains `embeddingProvider: EmbeddingProvider` param, forwarded to `processAgentTurn`
- `packages/gateway/src/index.ts` - `buildApp` passes `gatewayLlmProvider` (an `OpenAICompatibleProvider`, implements `EmbeddingProvider`) to `buildEventsRoute`
- `packages/control-plane/src/pulse-fetch.ts` - removed dead `graph::memory::episodic` trigger block + `isEpisodicSelf` guard
- `packages/workers/src/memory/gate3.integration.test.ts` - removed obsolete G3-1 test (subject deleted)
- `packages/workers/src/memory/episodic.worker.ts` - DELETED (D-01, replaced by TemplateProposalWorker)
- `packages/workers/src/memory/episodic.worker.test.ts` - DELETED (test for deleted worker)

## Decisions Made
1. **plainto_tsquery('english', ...) over 'simple'** — ADR-20-supplement's schema sketch shows `'simple'` tsvector config, but migration 003 already created `ts_doc` columns as `GENERATED ALWAYS AS (to_tsvector('english', ...)) STORED`, and migration 006 explicitly documents the `plainto_tsquery('english', ...)` decision for all Phase 2 BM25 queries (matching the actual stored tsvector dictionary, since `'english'` stemming != `'simple'` tokenization). Followed migration 006 + this plan's explicit interface spec, not the ADR's Phase-1 sketch.
2. **embeddingProvider threading through gateway** — `processAgentTurn`'s new 5th param required updating `buildEventsRoute` and `buildApp`. Used the existing `gatewayLlmProvider` (`OpenAICompatibleProvider`, already implements both `LLMProvider` and `EmbeddingProvider`) rather than constructing a new provider instance — matches the `packages/workers/src/index.ts` pattern of reusing one provider for both interfaces.
3. **mem::reflect has no registerTrigger** — per the plan's explicit note, it's invoked directly via `worker.trigger()` / `opts.memReflect.fn`, not topic-subscribed. Matches ADR-21's centralized-function design (Worker calls a single interface; no pub/sub fan-out needed).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] events.ts/buildApp broken by processAgentTurn signature change**
- **Found during:** Task 2 (`npm run typecheck` after index.ts/process-agent-turn.ts edits)
- **Issue:** `processAgentTurn(pool, scopeId, event, wMax, embeddingProvider)` now requires 5 args; `buildEventsRoute` called it with 4 (TS2554)
- **Fix:** Added `embeddingProvider: EmbeddingProvider` param to `buildEventsRoute`, forwarded to `processAgentTurn`; `buildApp` now passes `gatewayLlmProvider` (already an `OpenAICompatibleProvider` implementing `EmbeddingProvider`)
- **Files modified:** packages/gateway/src/routes/events.ts, packages/gateway/src/index.ts
- **Commit:** 3ffe7f42

**2. [Rule 3 - Blocking] gate3.integration.test.ts G3-1 imports deleted episodic.worker.js**
- **Found during:** Task 2 (`npm run typecheck` after deleting episodic.worker.ts)
- **Issue:** `gate3.integration.test.ts` G3-1 dynamically imports `./episodic.worker.js` and instantiates `EpisodicMemoryWorker` — module no longer exists (TS2307)
- **Fix:** Removed the G3-1 test block and its header-comment reference. EpisodicMemoryWorker is intentionally deleted per D-01; TPW's episodic write path is already covered by `packages/workers/src/memory/template-proposal.worker.test.ts` (Plan 02, 6/6 passing)
- **Files modified:** packages/workers/src/memory/gate3.integration.test.ts
- **Commit:** 3ffe7f42

**3. [Rule 1 - Bug] formatProcedural discarded oversized entries instead of consuming the budget**
- **Found during:** Task 3 (writing the budget-exhaustion test)
- **Issue:** Original implementation `break`'d (without pushing) when even the summary-only entry exceeded the remaining budget, leaving `procText = ''` / `pTokens = 0` — so episodic/semantic tiers incorrectly received the FULL budget instead of zero, contradicting the ADR-21 sequential-greedy-truncation invariant (`P_tokens + E_tokens + S_tokens <= B`, with episodic/semantic budgets derived as `B - P_tokens`)
- **Fix:** Always push the (possibly summary-truncated) entry; only stop adding *further* entries once the running total is exhausted. A single oversized entry now correctly consumes (and can exceed) its tier's budget, leaving 0 for downstream tiers — matching ADR-21's stated purpose ("预算裁断主要保护极端情况" — budget truncation primarily protects against extreme cases, by truncating the entry's content, not by silently dropping it)
- **Files modified:** packages/workers/src/memory/reflect.function.ts
- **Commit:** 7bbf155b (test commit — fix made while writing/debugging the test it covers)

---

**Total deviations:** 3 auto-fixed (2 blocking compile errors caused directly by this plan's signature change + worker deletion, 1 logic bug found via the new test suite)
**Impact on plan:** All three fixes were required for `npm run typecheck` and `npm test` to pass with the plan's changes. No scope creep — all fixes trace directly to files this plan already modifies/deletes.

## Issues Encountered
None beyond the deviations documented above.

## User Setup Required

None - no external service configuration required. `mem::reflect` reuses the existing `embeddingProvider` (env-configured `EMBEDDING_MODEL`/`LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY`) already wired in `packages/workers/src/index.ts`.

## Next Phase Readiness

- Phase 9 (memory-layers) is now feature-complete: all three memory tiers (episodic via TPW, semantic with supersession, procedural with dual HNSW) write correctly with embeddings, and `mem::reflect` provides cold_start Reflection Track injection.
- `npm run typecheck`: 0 errors. `npm test`: 283/283 passing (47 files passed, 7 skipped — DB-gated integration tests).
- `conflict_detected` and `macro_planning` triggers (ADR-21) remain wired in `computeReflectBudget`/`procLimit` but are not yet invoked anywhere — deferred to Phase 10 per 09-CONTEXT.md `<deferred>`.
- Pre-existing `tests/integration/idempotency.test.ts` TS2459 (`occWriteIdempotent` unexported, from commit `ce6f64b9`) remains out of scope and untouched.

---
*Phase: 09-memory-layers*
*Completed: 2026-06-11*

## Self-Check: PASSED
