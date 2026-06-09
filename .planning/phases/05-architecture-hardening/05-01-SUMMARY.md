---
phase: 05-architecture-hardening
plan: 01
subsystem: llm-provider
tags: [llm, failover, circuit-breaker, tdd]
dependency_graph:
  requires: []
  provides: [classifyProviderError, FallbackProvider, AllProvidersExhaustedError]
  affects: [packages/shared/src/llm/index.ts]
tech_stack:
  added: []
  patterns: [pure-function classification, strategy pattern, TDD red-green]
key_files:
  created:
    - packages/shared/src/llm/classify-error.ts
    - packages/shared/src/llm/classify-error.test.ts
    - packages/shared/src/llm/fallback.provider.ts
    - packages/shared/src/llm/fallback.provider.test.ts
  modified:
    - packages/shared/src/llm/index.ts
decisions:
  - classifyProviderError is a pure function with no class state — string matching via toLowerCase() for case-insensitive HTTP status codes and error keywords
  - FallbackProvider sorts providers at construction time (ascending priority), not per-call — avoids repeated sort overhead
  - Non-Error inputs to classifyProviderError are wrapped via new Error(String(err)) — preserves type safety throughout
  - AllProvidersExhaustedError extends Error with a fixed message — catchable by name and instanceof
metrics:
  duration_min: 2
  completed_date: "2026-06-09"
  tasks_completed: 2
  files_created: 4
  files_modified: 1
---

# Phase 05 Plan 01: Provider Safety — classifyProviderError + FallbackProvider Summary

## One-liner

Priority-ordered LLM failover with fatal/transient error classification: auth/context_length/content_filter re-throw immediately; rate_limit/overloaded/timeout/unknown try next provider.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | classifyProviderError failing tests | 65fcc9f | classify-error.test.ts |
| 1 (GREEN) | classifyProviderError implementation | dadaeb7 | classify-error.ts |
| 2 (RED) | FallbackProvider failing tests | b317f77 | fallback.provider.test.ts |
| 2 (GREEN) | FallbackProvider + barrel export | ef4b628 | fallback.provider.ts, index.ts |

## What Was Built

**classify-error.ts** — Pure function `classifyProviderError(err: unknown): ClassifiedError` with:
- `FailoverReason` union: `auth | rate_limit | overloaded | timeout | context_length | content_filter | unknown`
- `ClassifiedError` interface: `{ reason, shouldThrow, shouldFailover, original: Error }`
- Priority-ordered classification (auth checked first to prevent unnecessary failovers on credential errors)

**fallback.provider.ts** — `FallbackProvider implements LLMProvider` with:
- `ProviderEntry` interface: `{ name: string; provider: LLMProvider; priority: number }`
- `AllProvidersExhaustedError extends Error` with message "All LLM providers exhausted"
- Sorts providers ascending by priority at construction; iterates in order on `chat()`
- Re-throws immediately on `shouldThrow`; continues on `shouldFailover`; throws `AllProvidersExhaustedError` when list exhausted
- LLM CALL annotation at the delegation site (ADR 22)

**index.ts** — Two lines added to barrel export both new modules.

## Verification

- 10 tests in classify-error.test.ts: all pass
- 5 tests in fallback.provider.test.ts: all pass
- `npx tsc --noEmit` on root tsconfig: exit 0, no errors

## Deviations from Plan

None — plan executed exactly as written.

Note: `packages/shared/tsconfig.json` referenced in plan verification step does not exist in the project; the project uses the root `tsconfig.json`. The root tsc check was run instead and passed.

## TDD Gate Compliance

- RED gate: `test(05-01): add failing tests for classifyProviderError()` (65fcc9f)
- GREEN gate: `feat(05-01): implement classifyProviderError()` (dadaeb7)
- RED gate: `test(05-01): add failing tests for FallbackProvider` (b317f77)
- GREEN gate: `feat(05-01): implement FallbackProvider + barrel export` (ef4b628)

## Known Stubs

None.

## Threat Flags

None — no new network endpoints, auth paths, or file access patterns introduced. This plan adds pure in-process classification logic only.

## Self-Check: PASSED

- packages/shared/src/llm/classify-error.ts: FOUND
- packages/shared/src/llm/classify-error.test.ts: FOUND
- packages/shared/src/llm/fallback.provider.ts: FOUND
- packages/shared/src/llm/fallback.provider.test.ts: FOUND
- packages/shared/src/llm/index.ts (modified): FOUND
- Commit 65fcc9f: FOUND
- Commit dadaeb7: FOUND
- Commit b317f77: FOUND
- Commit ef4b628: FOUND
