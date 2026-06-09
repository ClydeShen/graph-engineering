---
phase: 05-architecture-hardening
plan: 02
subsystem: gateway
tags: [sse, streaming, pg_notify, hono, trail-delivery]
dependency_graph:
  requires:
    - packages/shared/src/occ-write.ts (pg_notify on 'graph_event_ready')
    - packages/gateway/src/index.ts (buildApp mounting)
  provides:
    - GET /v1/stream SSE endpoint (buildStreamRoute)
  affects:
    - packages/gateway/src/index.ts
tech_stack:
  added: []
  patterns:
    - "Hono streamSSE with dedicated pg client per SSE connection"
    - "try/finally client.release() for pg connection cleanup"
    - "LISTEN graph_event_ready bridging pg_notify to SSE data frames"
key_files:
  created:
    - packages/gateway/src/routes/stream.ts
    - packages/gateway/src/routes/stream.test.ts
  modified:
    - packages/gateway/src/index.ts
decisions:
  - "pool.connect() inside streamSSE callback — dedicated client lifecycle scoped to stream lifetime"
  - "try/finally around inner connection block ensures client.release() on disconnect (T-05-02-03 mitigation)"
  - "outer try/catch before streamSSE return handles pre-stream errors returning 500"
  - "Test 3 mocks streamSSE to throw synchronously to test the outer 500 path cleanly"
  - "callbackDone promise in Test 2 ensures async client.on registration completes before assertion"
metrics:
  duration_min: 8
  completed_date: "2026-06-09"
  tasks_completed: 2
  files_modified: 3
---

# Phase 05 Plan 02: SSE Stream Route Summary

SSE endpoint bridging `pg_notify` on `graph_event_ready` to live HTTP streams via `buildStreamRoute(pool)` — MemexTerminal subscribes once and receives real-time trail events without polling.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Create buildStreamRoute and mount in gateway | 0119df0 | stream.ts (new), index.ts (+1 import, +1 route) |
| 2 | Test buildStreamRoute | 22569c78 | stream.test.ts (new, 3 tests) |

## What Was Built

**Task 1 — `buildStreamRoute`** (`packages/gateway/src/routes/stream.ts`):
- `export function buildStreamRoute(pool: Pool): Hono` following the `buildHealthRoute` builder pattern
- Route: `GET /stream` (mounted at `/v1` so full path is `/v1/stream`)
- Acquires dedicated pg client from pool per SSE connection
- Executes `LISTEN graph_event_ready` on the dedicated client
- Forwards each `pg_notify` payload as an SSE data frame via `client.on('notification', ...)`
- Sends keep-alive `ping` event every 30s while `!stream.closed`
- `try/finally` ensures `client.release()` on disconnect (T-05-02-03 mitigation)
- Outer `try/catch` returns 500 JSON for errors before SSE headers are sent

**index.ts** (`packages/gateway/src/index.ts`):
- Import: `import { buildStreamRoute } from './routes/stream.js'`
- Mount: `app.route('/v1', buildStreamRoute(pool))` after memory route

**Task 2 — `stream.test.ts`** (`packages/gateway/src/routes/stream.test.ts`):
- 3 vitest tests with mocked `hono/streaming` streamSSE and mocked pg Pool/PoolClient
- Test 1: SSE Content-Type assertion — `streamSSE` called, response has `text/event-stream` header
- Test 2: Notification forwarding — `client.on('notification', handler)` captured, invoked with payload, `writeSSE` called with matching data
- Test 3: Pool connect failure (500 path) — `streamSSE` mock throws synchronously, outer catch returns 500

## Verification

```
npx tsc --noEmit           # exits 0 (whole workspace)
npx vitest run packages/gateway/src/routes/stream.test.ts  # 3 passed
```

Both exit 0.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Cast `unknown as` in test mock**
- **Found during:** Task 2 tsc --noEmit
- **Issue:** Mock stream object `{ writeSSE, sleep, closed }` doesn't overlap structurally with `SSEStreamingApi` — TypeScript rejected direct `as Parameters<typeof callback>[0]` cast
- **Fix:** Changed to `as unknown as Parameters<typeof callback>[0]` (double cast through `unknown`)
- **Files modified:** `packages/gateway/src/routes/stream.test.ts`
- **Commit:** 22569c78

**2. [Rule 1 - Bug] Async callback timing in notification test**
- **Found during:** Task 2 first test run
- **Issue:** `vi.mock` streamSSE called `void callback(...)` (fire-and-forget), so `pool.connect()` and `client.on` registration happened after the test assertion
- **Fix:** Added `callbackDone` promise; mock does `.then(resolveCallback)`; test `await callbackDone` before checking `capturedNotificationHandler`
- **Files modified:** `packages/gateway/src/routes/stream.test.ts`
- **Commit:** 22569c78

## Known Stubs

None — implementation is fully wired. No placeholder data or TODO paths.

## Threat Flags

No new threat surface beyond what is documented in the plan's threat model. T-05-02-03 (pg client leak) is mitigated by `try/finally client.release()`.

## Self-Check: PASSED

- [x] `packages/gateway/src/routes/stream.ts` — exists
- [x] `packages/gateway/src/routes/stream.test.ts` — exists
- [x] `packages/gateway/src/index.ts` — contains `buildStreamRoute` import and mount
- [x] Commit `0119df0` — verified in git log
- [x] Commit `22569c78` — verified in git log
- [x] `tsc --noEmit` — exits 0
- [x] `vitest run stream.test.ts` — 3/3 pass
