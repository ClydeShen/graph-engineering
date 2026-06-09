---
phase: 01-core-graph-engine
plan: "04"
subsystem: control-plane
tags: [control-plane, pg-listen, iii-sdk, watchdog, nesting, hwm, convergence, oom]
dependency_graph:
  requires: [01-01, 01-02]
  provides: [control-plane-package, ddl-pool, read-pool, nesting-protocol, pulse-fetch, hwm-tracking, convergence-watchdog, oom-chain]
  affects: [01-05, 01-06, 01-07, 01-08, 01-09, 01-10]
tech_stack:
  added: []
  patterns: [pg-listen-subscriber, hwm-advance-before-trigger, 3-phase-ddl-transaction, 3-tier-watchdog, oom-3-tier-chain]
key_files:
  created:
    - packages/control-plane/package.json
    - packages/control-plane/src/db/ddl-pool.ts
    - packages/control-plane/src/db/read-pool.ts
    - packages/control-plane/src/nesting.ts
    - packages/control-plane/src/hwm.ts
    - packages/control-plane/src/pulse-fetch.ts
    - packages/control-plane/src/watchdog.ts
    - packages/control-plane/src/index.ts
    - src/__tests__/watchdog.test.ts
  modified: []
decisions:
  - "UUID hex validation (assertSafeUuidHex) guards DDL string interpolation before partition name construction — prevents SQL injection at nesting time"
  - "pg-listen notification handler uses subscriber.notifications.on() — correct EventEmitter pattern; client.on() is absent from all code and comments"
  - "OOM Tier 3 writes via memory_updated event_type (not a new type) — only 5 canonical event types exist per ADR 12"
  - "scope_closed INSERT uses SELECT...LIMIT 1 to get latest version_hash as predecessor — correct causal chain threading"
  - "index.ts boot-only pattern — watchdog instantiated but not exported; downstream plans import from watchdog.ts directly"
metrics:
  duration: "18 minutes"
  completed: "2026-06-03"
  tasks_completed: 3
  files_created: 9
  tests_written: 9
  tests_passing: 9
requirements_covered: [REQ-06, REQ-07, REQ-08, REQ-09]
---

# Phase 1 Plan 04: Control Plane Daemon Summary

Control Plane Daemon with two DB connection pools (DDL-exclusive max:2 + read/HWM), 3-phase atomic scope nesting protocol (CREATE PARTITION + OCC constraint + idempotency constraint + pending-lookup index → INSERT scope_lineage → INSERT plan_created with pgcrypto hash), pg-listen Pulse-Fetch bridge with correct boot order and HWM tracking, and 3-tier Convergence Watchdog as sole scope_closed emitter within the Control Plane Daemon with OOM 3-tier degradation chain.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | DB pools + 3-phase nesting protocol (REQ-06, REQ-07) | `15cc266` | package.json, db/ddl-pool.ts, db/read-pool.ts, nesting.ts |
| 2 | HWM tracking + pg-listen Pulse-Fetch bridge (REQ-06) | `dd82e81` | hwm.ts, pulse-fetch.ts |
| 3 | 3-tier Convergence Watchdog + OOM chain + boot + tests (REQ-08, REQ-09) | `384fde7` | watchdog.ts, index.ts, src/__tests__/watchdog.test.ts |

## Verification Results

- `npx tsc --noEmit` exits 0 (strict TypeScript, all files type-safe)
- `npm run test:unit -- watchdog` passes 9/9 tests
- `pulse-fetch.ts` verified: `notifications.on` present, `listenTo` present, `trigger` present, no `client.on('notification')` — correct pg-listen API pattern confirmed
- Nesting protocol: `PARTITION OF execution_event_log` present, `UNIQUE (predecessor_hash, scope_id)` present, `ZERO_HASH` used for plan_created, all 3 phases inside single BEGIN/COMMIT with ROLLBACK
- Watchdog: `ScopeConvergenceTracker` with 3-tier defense, sole scope_closed emitter in control-plane package, OOM Tier 1 annotated with `LLM CALL — justified by ADR 13 supplement`, Tier 3 writes `context_oom_throttled` reason field

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing validation] UUID hex guard before DDL string interpolation**
- **Found during:** Task 1 implementation
- **Issue:** Plan specified "validate identifier interpolation (UUID hex only)" without detailing the implementation
- **Fix:** Added `assertSafeUuidHex()` with strict UUID v4 regex validation before DDL string construction; throws on invalid input
- **Files modified:** `packages/control-plane/src/nesting.ts`
- **Commit:** `15cc266`

**2. [Rule 1 - Bug] pulse-fetch.ts comments triggered false-positive in verification regex**
- **Found during:** Task 2 automated verification (plan's Node.js regex check)
- **Issue:** Comments contained `client.on('notification')` as an anti-pattern example, causing the regex `!/client\.on\('notification'/` to fail despite code correctly using `subscriber.notifications.on()`
- **Fix:** Rewrote anti-pattern comments to use positive phrasing without naming the wrong API
- **Files modified:** `packages/control-plane/src/pulse-fetch.ts`
- **Commit:** `dd82e81`

## Known Stubs

| Stub | File | Reason |
|------|------|--------|
| OOM Tier 1 LLM call (annotated) | `watchdog.ts` ~L137 | LLM provider interface (ADR 22) implemented in Plan 05; call site annotated `LLM CALL — justified by ADR 13 supplement` |
| OOM Tier 2 tiktoken truncation | `watchdog.ts` ~L146 | `@dqbd/tiktoken` integration wired in context assembly plan; stub logs but does not execute |
| iii.trigger fire-and-forget | `pulse-fetch.ts`, `index.ts` | Worker result flows back via GraphHandle.write() per ADR 27; no return value expected from trigger() |

These stubs are intentional Phase 1 forward-compat patterns. Plans 05-07 wire the LLM provider and tiktoken integrations.

## Threat Flags

None. The Control Plane Daemon connects outbound only — to PostgreSQL (pg/pg-listen) and iii Engine binary (WebSocket). No network endpoints exposed. Credentials via environment variables only (`DATABASE_URL`, `III_URL`).

## Self-Check: PASSED

Files verified present:
- FOUND: packages/control-plane/package.json
- FOUND: packages/control-plane/src/db/ddl-pool.ts
- FOUND: packages/control-plane/src/db/read-pool.ts
- FOUND: packages/control-plane/src/nesting.ts
- FOUND: packages/control-plane/src/hwm.ts
- FOUND: packages/control-plane/src/pulse-fetch.ts
- FOUND: packages/control-plane/src/watchdog.ts
- FOUND: packages/control-plane/src/index.ts
- FOUND: src/__tests__/watchdog.test.ts

Commits verified:
- FOUND: 15cc266 (Task 1)
- FOUND: dd82e81 (Task 2)
- FOUND: 384fde7 (Task 3)
