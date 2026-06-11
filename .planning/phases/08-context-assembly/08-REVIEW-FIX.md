---
phase: 08-context-assembly
fixed_at: 2026-06-10T23:05:00Z
review_path: .planning/phases/08-context-assembly/08-REVIEW.md
iteration: 1
findings_in_scope: 5
fixed: 5
skipped: 0
status: all_fixed
---

# Phase 08: Code Review Fix Report

**Fixed at:** 2026-06-10T23:05:00Z
**Source review:** .planning/phases/08-context-assembly/08-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 5
- Fixed: 5
- Skipped: 0

All 280 tests passed after applying fixes (47 test files, 36 skipped integration tests).

## Fixed Issues

### WR-01: CCR Tool Description References Wrong Sentinel Format

**Files modified:** `packages/workers/src/context/ccr.ts`
**Commit:** 74bc99ca
**Applied fix:** Updated `createMemexRetrieveTool()` description from the wrong headroom format `[N items compressed... hash=HASH]` to the actual format `<<ccr:HASH N_dropped>>` with a concrete example. Also updated the `hash` property description in `input_schema` to match the new format example.

---

### WR-02: STABLE_SYSTEM_ROLE Contradicts CCR Instructions When Drops Occur

**Files modified:** `packages/workers/src/context/assemble.ts`
**Commit:** 8ac6d2a7
**Applied fix:** Replaced the pre-Phase-08 text ("sliding-window discarder — older events are dropped, not summarized. Retrieve older context via graph queries if needed.") with accurate Phase-08 description ("token-budget greedy slicer — older events beyond the budget are excluded from this context slice. Excluded events may be retrievable via the memex_retrieve tool when indicated."). The new text no longer contradicts the CCR directional channel and correctly names the actual mechanism.

---

### WR-03: `tokensBefore` and `tokensAfter` in PipelineContext Measure Incomparable Quantities

**Files modified:** `packages/workers/src/base/worker.abstract.ts`, `packages/workers/src/context/assemble.ts`, `packages/workers/src/context/assemble.test.ts`, `packages/workers/src/base/worker.abstract.test.ts`
**Commit:** 9afbb59d
**Applied fix:** Renamed `tokensBefore` → `volatileTokens` and `tokensAfter` → `contextLayerTokens` across the `PipelineContext` interface and all four files that reference it. Added JSDoc comments to the interface fields clarifying what each measures. Updated test comments and assertions to use the new names. Updated the JSDoc in `runContextAssemblyPipeline` to reference the new names.

---

### WR-04: `JSON.stringify(currentInput)` Can Throw on Circular Input

**Files modified:** `packages/workers/src/context/assemble.ts`
**Commit:** 35adf143
**Applied fix:** Added a `safeStringify(value: unknown): string` helper function that catches `TypeError` thrown by circular structures and falls back to `JSON.stringify(String(value))`. Replaced both `JSON.stringify(currentInput)` call sites (line 174 in `assembleContext` and line 259 in `runContextAssemblyPipeline`) with `safeStringify(currentInput)`.

---

### WR-05: No Guard When `stableTokens + volatileTokens` Exceeds `wMax`

**Files modified:** `packages/workers/src/context/assemble.ts`
**Commit:** 1f7fe26f
**Applied fix:** Added a defensive check after `computeContextBudgets` in `assembleContext`. When `stableTokens + volatileTokens > wMax`, emits a `console.warn` describing the exact token counts, the exceeded budget, and the consequence (all context events dropped to CCR, assembled prompt will exceed budget). The function continues normally — the warn is observability only, not a throw.

---

_Fixed: 2026-06-10T23:05:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
