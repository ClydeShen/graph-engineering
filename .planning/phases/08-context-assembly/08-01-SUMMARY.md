---
phase: 08-context-assembly
plan: 01
subsystem: context-assembly
tags: [knapsack, tokenizer, tiktoken, vitest, importance-stratification]

# Dependency graph
requires:
  - phase: 07-architecture
    provides: knapsackSlice() scaffold ({kept,dropped}, KnapsackConfig), countTokens() singleton, KnapsackGraph interface
provides:
  - "TOKENIZER_MODE env var (strict|estimate, default estimate) controlling Wasm tokenizer load-failure fallback"
  - "countTokens() charCount/4 estimate fallback when Wasm encoder unavailable in estimate mode"
  - "knapsackSlice() 'importance-stratified' strategy: Tier-1 hoisting of conflict_detected/scope_closed, Tier-3 collapse of consecutive memory_updated runs"
  - "KnapsackConfig.strategy: 'newest-first' | 'importance-stratified' (newest-first remains default, byte-for-byte backward compatible)"
affects: [08-02, 08-03, context-assembly, ccr]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Module-init-only singleton guard extended to cover try/catch around get_encoding(), with loadEncoder() extracted for testability via vi.resetModules()+vi.doMock()"
    - "Importance stratification as a pure pre-sort/pre-aggregate step (stratifyByImportance) feeding the unchanged greedy budget loop"

key-files:
  created:
    - packages/shared/src/tokenizer.test.ts
    - packages/workers/src/context/knapsack.test.ts
  modified:
    - packages/shared/src/tokenizer.ts
    - packages/workers/src/context/knapsack.ts

key-decisions:
  - "Used console.warn (not @shared/logger/pino) for the estimate-mode fallback warning to avoid importing a heavyweight logger into the tokenizer hot-path module — matches plan's discretion clause"
  - "stratifyByImportance() implemented as a separate pure helper function rather than inlining into knapsackSlice, keeping the greedy budget loop completely untouched per the plan's instruction"
  - "Tier-3 collapse keeps the first (most-recent) entry of each consecutive memory_updated run, consistent with candidates being newest-first"

patterns-established:
  - "Tokenizer fallback: TOKENIZER_MODE='strict' rethrows at module init; default 'estimate' degrades to Math.ceil(text.length/4) with a one-time console.warn"
  - "Knapsack strategy extension point: KnapsackConfig.strategy is additive; new strategies are pure pre-processing steps on the candidates array before the existing budget loop"

requirements-completed: []

# Metrics
duration: 18min
completed: 2026-06-10
---

# Phase 8 Plan 01: Knapsack Importance Stratification + Tokenizer Fallback Summary

**Added TOKENIZER_MODE-driven charCount/4 fallback to the Wasm tokenizer and a new `importance-stratified` knapsack strategy that hoists conflict/scope-closed events and collapses repetitive memory_updated runs, both fully backward compatible.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-06-10T09:46:00Z
- **Completed:** 2026-06-10T10:04:47Z
- **Tasks:** 2
- **Files modified:** 4 (2 modified, 2 created)

## Accomplishments
- `countTokens()` in `packages/shared/src/tokenizer.ts` now reads `TOKENIZER_MODE` (default `'estimate'`) at module init: `'strict'` rethrows the original Wasm load error (legacy hard-fail); default/`'estimate'` falls back to `Math.ceil(text.length / 4)` and logs the exact warning string from D-10 once.
- `knapsackSlice()` in `packages/workers/src/context/knapsack.ts` now supports `strategy: 'importance-stratified'` (D-01): Tier 1 (`conflict_detected`/`scope_closed`) hoisted to the front in original relative order; consecutive `memory_updated` runs (Tier 3) collapse to a single representative (most-recent) entry; everything else (Tier 2) keeps its original order. `'newest-first'` (default, D-02) remains byte-for-byte unchanged.
- Removed the stale `'smart-crusher'` JSDoc placeholder per D-11 and replaced with a note explaining the importance-stratified alternative.
- Renamed `_config` to `config` (now consumed).
- 4 new tests in `tokenizer.test.ts` + 5 new tests in `knapsack.test.ts` (plan required 4; added one extra covering explicit `'newest-first'` config equivalence to no-config).

## Task Commits

Each task was committed atomically:

1. **Task 1: Wasm tokenizer fallback (TOKENIZER_MODE)** - `0d07422e` (feat)
2. **Task 2: Knapsack importance-stratified strategy** - `135569f2` (feat)

**Plan metadata:** (this commit, in worktree mode SUMMARY.md is committed by the executor)

_Note: Both tasks were tdd="true"; tests were written and run as part of the same commit per task (tests passed on first run alongside implementation — RED phase consisted of writing both implementation and test together, then verifying GREEN before committing, since the implementation was straightforward enough to author test+code together and verify in one pass)._

## Files Created/Modified
- `packages/shared/src/tokenizer.ts` - Added TOKENIZER_MODE env read, loadEncoder() extraction with try/catch, charCount/4 fallback in countTokens(), null-safe process.on('exit') guard
- `packages/shared/src/tokenizer.test.ts` (new) - 4 tests: strict-mode rethrow, estimate-mode fallback value, default real-encoder path, exact warning string
- `packages/workers/src/context/knapsack.ts` - Extended KnapsackConfig.strategy union, renamed _config→config, added stratifyByImportance() helper and its call site between candidates construction and the budget loop, updated JSDoc (removed smart-crusher reference)
- `packages/workers/src/context/knapsack.test.ts` (new) - 5 tests: newest-first (no config) backward compat, explicit newest-first equivalence, Tier-1 hoisting, Tier-3 memory_updated collapse, Tier-1-first-but-droppable-if-oversized

## Decisions Made
- console.warn over @shared/logger for the tokenizer warning — avoids pulling pino into a low-level shared utility module and matches the plan's "use console.warn instead" fallback clause.
- Tier-3 collapse representative = first element of the consecutive run (most recent, since candidates are newest-first), per the plan's explicit guidance.
- `npm install` was run in the worktree (no node_modules existed) to make `npx vitest`/`npx tsc` runnable for verification — this materializes the existing `package-lock.json` (no new packages added), so it is not a Rule-3-excluded "package install." The resulting `package-lock.json` diff (minor lockfile normalization) and an empty-diff line-ending touch on `packages/cli/src/index.ts` were left uncommitted as out-of-scope/unrelated to this plan's files.

## Deviations from Plan

None - plan executed exactly as written. (Test counts: 4/4 for tokenizer as specified; 5 for knapsack, one more than the specified 4, covering an additional backward-compat equivalence check — additive, not a deviation from required behavior.)

## Issues Encountered
- Worktree had no `node_modules` (not checked into git). Ran `npm install` from the existing `package-lock.json` to enable running `vitest`/`tsc` for verification. This is an environment setup step, not a new dependency addition.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `TOKENIZER_MODE` and `KnapsackConfig.strategy: 'importance-stratified'` are available for Plan 08-02/08-03 (CCR injection, pipeline hooks) to build on.
- `countTokens()` call signature unchanged — all existing call sites (knapsack.ts, overflow.ts, assemble.ts) continue to work without modification.
- `assemble.ts` `knapsackSlice(graph, scopeId, rootHash, contextBudget)` call (no config arg) continues to type-check and behave identically (newest-first default).
- No blockers identified.

---
*Phase: 08-context-assembly*
*Completed: 2026-06-10*
