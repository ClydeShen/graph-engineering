---
status: complete
phase: 05-architecture-hardening
source:
  - .planning/phases/05-architecture-hardening/05-01-SUMMARY.md
  - .planning/phases/05-architecture-hardening/05-02-SUMMARY.md
  - .planning/phases/05-architecture-hardening/05-03-SUMMARY.md
  - .planning/phases/05-architecture-hardening/05-04-SUMMARY.md
  - .planning/phases/05-architecture-hardening/05-05-SUMMARY.md
  - .planning/phases/05-architecture-hardening/05-06-SUMMARY.md
started: "2026-06-09T00:00:00.000Z"
updated: "2026-06-10T00:07:00.000Z"
---

## Current Test

[testing complete]

## Tests

### 1. Cold Start Smoke Test
expected: |
  Kill any running gateway/workers processes. Start the gateway from scratch
  (e.g., `npx tsx packages/gateway/src/index.ts` or equivalent npm script).
  The server should boot without errors, connect to the database, and respond
  to `GET /health` (or equivalent health check) with a 200. No unhandled
  exceptions, no missing module errors, no tsc compile errors on startup.
result: pass

### 2. LLM Error Classification — Fatal vs. Transient
expected: |
  Run: `npx vitest run packages/shared/src/llm/classify-error.test.ts`
  All 10 tests should pass. Specifically verify:
  - Auth errors → shouldThrow: true, shouldFailover: false (no retry)
  - Rate limit / overloaded / timeout errors → shouldThrow: false, shouldFailover: true (retry next provider)
  - Unknown errors → shouldFailover: true (conservative: try next provider)
result: pass

### 3. FallbackProvider Chains Through Providers
expected: |
  Run: `npx vitest run packages/shared/src/llm/fallback.provider.test.ts`
  All 5 tests pass. Key behavior: when the first provider throws a transient
  error (rate_limit/overloaded), FallbackProvider silently advances to the
  second provider. When ALL providers are exhausted, it throws
  AllProvidersExhaustedError. Fatal errors (auth/context_length) re-throw
  immediately without trying the next provider.
result: pass

### 4. SSE Stream Endpoint Connects
expected: |
  `npx vitest run packages/gateway/src/routes/stream.test.ts` — 3 tests pass.
  Content-Type text/event-stream, pg_notify forwarded to SSE frames, pool
  connect failure returns 500. try/finally ensures client.release() on disconnect.
result: pass
note: JSON error log in test output is expected — emitted by Hono logger during the 500-path test.

### 5. @graph/types Sub-paths Compile Clean
expected: |
  `npx tsc --noEmit` exits 0. @graph/types has zero @graph/* deps.
  All sub-paths (core/api/shell) resolve correctly.
result: pass

### 6. Memex Config Loader — Null-Safe Behaviour
expected: |
  `npx vitest run packages/shared/src/config/loader.test.ts` — 7 tests pass.
  Missing file → null, malformed JSON → null, valid config → object,
  ${ENV_VAR} substituted, Zod failure → null.
result: pass

### 7. Skills List Returns Summaries Only
expected: |
  `npx vitest run packages/gateway/src/routes/skills.test.ts` — 12 tests pass.
  GET /v1/skills returns {fingerprintId, name, description} — no content field.
  Empty/missing directory → {skills: []}.
result: pass

### 8. Skills Detail Returns Full Content — Invalid IDs Blocked
expected: |
  GET /v1/skills/:id returns full SKILL.md content or 404 for missing.
  Non-hex-64-char id → 400. Path traversal guard enforced via regex.
result: pass

### 9. CrystallizeWorker Delta vs Full Distillation
expected: |
  `npx vitest run packages/workers/src/memory/crystallize.worker.test.ts` — 5 tests pass.
  Existing lesson in procedural_memory → delta prompt ("ONLY the delta", "EXISTING LESSON:").
  No existing lesson → full distillation prompt ("Distill these execution traces...").
result: pass

## Summary

total: 9
passed: 9
issues: 0
pending: 0
skipped: 0

## Gaps

[none yet]
