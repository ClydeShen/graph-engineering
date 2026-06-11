---
phase: 08-context-assembly
plan: 03
subsystem: context-assembly
tags: [ccr, compression, knapsack, pipeline-hooks, worker, vitest]

# Dependency graph
requires:
  - phase: 08-context-assembly
    plan: 01
    provides: knapsackSlice() with {kept,dropped} + KnapsackConfig.strategy
  - phase: 08-context-assembly
    plan: 02
    provides: PipelineContext interface + 4 no-op protected Worker pipeline hooks
provides:
  - "ccr.ts: MEMEX_RETRIEVE_TOOL_NAME, buildCcrSentinel(), createCcrStore(), createMemexRetrieveTool(), createMemexRetrieveInstructions(), createMemexRetrieveExecute()"
  - "assembleContext() extended: ccrHashes[], ccrInstructions?, droppedCount, union context type — STABLE_SYSTEM_ROLE unchanged"
  - "runContextAssemblyPipeline(): orchestration wrapper calling onContextAssembled (always) and onContextCompressed (when droppedCount>0)"
affects: [09-reflection-track, gateway (process-agent-turn.ts type-safe with new optional params)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CCR sentinel <<ccr:HASH N_dropped>> appended as last context element when knapsack drops events (D-04)"
    - "Invocation-scoped CcrStore factory (per-call Map, no module-global state) following knapsack-graph.ts eventCache pattern (D-05)"
    - "HookCaller cast pattern for calling protected Worker hooks from a free function (runContextAssemblyPipeline)"
    - "Union context type (EventLogNode | {_ccr_dropped: string})[] for T-08-06 sentinel shape isolation"

key-files:
  created:
    - packages/workers/src/context/ccr.ts
    - packages/workers/src/context/ccr.test.ts
    - packages/workers/src/context/assemble.test.ts
  modified:
    - packages/workers/src/context/assemble.ts

key-decisions:
  - "STABLE_SYSTEM_ROLE remains byte-identical — CCR instructions go into AssembledContext.ccrInstructions (separate optional field), resolving D-03/ADR-30-D-1 tension"
  - "HookCaller local type alias used for protected access in runContextAssemblyPipeline — TypeScript protected is compile-time only; cast is intentional and documented (D-08)"
  - "contentFingerprint() reused for CCR sentinel HASH (not raw node:crypto) per D-04 Claude's Discretion note — matches existing hash conventions"
  - "context field union type (EventLogNode | {_ccr_dropped: string})[] preferred over 'as unknown as' cast per plan instruction (T-08-06 compile-time narrowing guard)"

requirements-completed: []

# Metrics
duration: ~35min
completed: 2026-06-10
---

# Phase 8 Plan 03: CCR Reversible Compression + Context Assembly Pipeline Summary

**Implemented D-03/D-04/D-05/D-12 CCR reversible compression: new `ccr.ts` provides the memex_retrieve tool definition, sentinel formatting, and invocation-scoped drop store; `assembleContext()` injects the <<ccr:HASH N_dropped>> sentinel and CCR instructions when events are dropped; `runContextAssemblyPipeline()` orchestrates the Plan-02 pipeline hooks with a populated PipelineContext.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-06-10T22:20:00Z
- **Completed:** 2026-06-10T22:33:00Z
- **Tasks:** 2
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments

- `packages/workers/src/context/ccr.ts` (new):
  - `MEMEX_RETRIEVE_TOOL_NAME = 'memex_retrieve'` constant
  - `buildCcrSentinel(dropped)`: formats `<<ccr:HASH N_dropped>>` sentinel using `contentFingerprint()` (SHA-256 of joined version_hashes); returns `null` for empty dropped array
  - `createCcrStore()`: per-call factory returning an independent `Map<string, EventLogNode[]>` (D-05 invocation-scoped, no module-global state)
  - `createMemexRetrieveTool()`: Anthropic tool definition ported from headroom's `tool_injection.py` lines 75-102 with `memex_retrieve` name (D-12)
  - `createMemexRetrieveInstructions(hashes)`: system-prompt directional guidance; returns `''` for empty array (D-03)
  - `createMemexRetrieveExecute(store)`: closure-based `execute()` handler over `CcrStore`, with simple substring-match query filter (open question 1 resolved)

- `packages/workers/src/context/assemble.ts` (extended):
  - `AssembledContext` interface gets `ccrHashes: string[]`, `ccrInstructions?: string`, `droppedCount: number`; `context` type is now `(EventLogNode | { _ccr_dropped: string })[] | null`
  - `assembleContext()` gains 7th/8th optional params (`knapsackConfig?`, `ccrStore?`); captures both `kept` and `dropped` from `knapsackSlice()`; injects CCR sentinel when `dropped.length > 0`; `STABLE_SYSTEM_ROLE` remains byte-identical (D-03/ADR-30-D-1 resolved)
  - `runContextAssemblyPipeline()` (new export): orchestration wrapper computing `tokensBefore`/`tokensAfter`, calling `onContextAssembled` always and `onContextCompressed` only when `droppedCount > 0` (D-06/D-07/D-08/D-13)
  - Existing 6-arg call site in `process-agent-turn.ts` type-checks unchanged (new params are optional/additive)

- Test coverage: 6 passing tests in `ccr.test.ts` + 5 passing tests in `assemble.test.ts` = 11 new tests

## Task Commits

Each task was committed atomically:

1. **Task 1: ccr.ts — sentinel, in-process store, memex_retrieve tool definition + handler** - `2a8e5fac` (feat)
2. **Task 2: Wire CCR into assembleContext() + add runContextAssemblyPipeline()** - `dbd86d9b` (feat)

## Files Created/Modified

- `packages/workers/src/context/ccr.ts` (new) — CCR module with all required exports (170 lines)
- `packages/workers/src/context/ccr.test.ts` (new) — 6 tests for ccr.ts exports
- `packages/workers/src/context/assemble.ts` (extended) — CCR wiring + runContextAssemblyPipeline() (190 lines)
- `packages/workers/src/context/assemble.test.ts` (new) — 5 tests for CCR wiring and pipeline hooks

## Decisions Made

- `STABLE_SYSTEM_ROLE` remains the exported constant unchanged. CCR instructions are placed in `AssembledContext.ccrInstructions` (new separate optional field), not appended to `stable`. This resolves the D-03/ADR-30-D-1 tension: the stable layer stays byte-identical for Anthropic prompt-cache eligibility while CCR guidance varies per-invocation in the new field.
- `HookCaller` local type alias used for the protected hook cast in `runContextAssemblyPipeline()`. TypeScript `protected` is compile-time only; the cast is intentional and documented inline. This matches the plan's explicit instruction for this case.
- `contentFingerprint()` reused for CCR sentinel HASH (not a new `node:crypto` call), matching existing hash conventions per D-04's Claude's Discretion note.
- `context` field union type `(EventLogNode | { _ccr_dropped: string })[] | null` preferred over `as unknown as` cast per plan instruction — TypeScript will enforce narrowing at call sites that access `EventLogNode`-specific fields (T-08-06).
- `ccrStore?` parameter is optional on `assembleContext()` — when omitted, the sentinel and instructions are still computed (D-04 always applies when drops occur) but payloads are not cached. Tests can call `assembleContext()` without a store.

## Deviations from Plan

None — plan executed exactly as written. All acceptance criteria passed; both tasks followed TDD (RED then GREEN).

## Pre-Existing Issues (noted, not caused by 08-03)

The `.continue-here.md` mentioned 3 failing tests in `packages/gateway/src/routes/mcp.test.ts` (execute_bash). When run during this session, those tests passed (3 passed, 2 skipped) — not failing. Likely already resolved between Wave 1 and now, or platform-dependent. Not investigated further; not related to 08-03 changes.

## Known Stubs

None.

## Threat Flags

No new security-relevant surface beyond what was planned in the 08-03 threat model (T-08-04, T-08-05, T-08-06 mitigations applied as designed).

---
*Phase: 08-context-assembly*
*Completed: 2026-06-10*
