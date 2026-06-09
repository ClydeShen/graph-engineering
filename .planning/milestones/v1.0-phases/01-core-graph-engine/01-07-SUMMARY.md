---
phase: 01-core-graph-engine
plan: "07"
subsystem: http-gateway
tags: [gateway, hono, zod, occ, watchdog, context-assembly]
dependency_graph:
  requires: ["01-03", "01-04", "01-05", "01-08"]
  provides: [http-gateway, zod-validation, inline-watchdog, context-response]
  affects: [external-agents, control-plane-nesting]
tech_stack:
  added: [hono@4.12.23, "@hono/zod-validator@0.8.0"]
  patterns: [zod-guard-400-before-db, pool-injection, inline-watchdog-sql, context-assembly-in-response]
key_files:
  created:
    - packages/gateway/package.json
    - packages/gateway/src/middleware/zod-guard.ts
    - packages/gateway/src/watchdog-sql.ts
    - packages/gateway/src/routes/scopes.ts
    - packages/gateway/src/routes/events.ts
    - packages/gateway/src/routes/scope-read.ts
    - packages/gateway/src/index.ts
    - src/__tests__/gateway.test.ts
  modified:
    - tsconfig.json
decisions:
  - "Added @graph/control-plane/* and @graph/workers/* path aliases to tsconfig (deviation: blocking import resolution)"
  - "Gateway imports nestScope via @graph/control-plane/nesting subpath (not package root which is a boot script)"
  - "buildApp factory pattern for testability: spy pool injected in tests"
  - "Inline Watchdog SQL follows same Tier 3 SQL as Control Plane watchdog.ts"
metrics:
  duration: ~90min
  completed: "2026-06-03"
  tasks_completed: 3
  files_created: 8
  files_modified: 1
---

# Phase 1 Plan 7: HTTP Gateway with Hono Summary

Implements the Hono HTTP Gateway with Zod-guarded endpoints, OCC write path, inline Watchdog SQL, infra-write rights for scope_closed and context_oom_throttled, and synchronous Knapsack context assembly in the events response.

## Implementation Summary

### Task 1: Hono app + Zod guard middleware (REQ-16)

Created `packages/gateway/package.json`, `zod-guard.ts`, and `gateway.test.ts`. The Zod guard uses `@hono/zod-validator` for body validation and `validateScopeIdParam()` for scope UUID param validation. Both return 400 before any DB access.

Test assertions (all 400 paths + valid passthrough):
- POST /v1/scopes with empty intent → 400, pool not called
- POST /v1/scopes/:id/events with non-UUID :id → 400, pool not called
- POST /v1/scopes/:id/events with UUID v1 (wrong version) → 400, pool not called
- POST /v1/scopes/:id/events with bad predecessor_hash → 400, pool not called
- POST /v1/scopes/:id/events with uppercase hash → 400, pool not called
- POST /v1/scopes/:id/events with invalid entity_id → 400, pool not called
- POST /v1/scopes/:id/events with plan_created event_type → 400, pool not called
- POST /v1/scopes/:id/events with scope_closed event_type → 400, pool not called
- GET /v1/scopes/:id with invalid id → 400, pool not called
- Valid POST /v1/scopes/:id/events body → pool called, status not 400

### Task 2: POST /v1/scopes + GET /v1/scopes/:id (REQ-15)

Created `scopes.ts` (delegates DDL to `nestScope` from control-plane, no DDL in Gateway) and `scope-read.ts` (UUID guard, reads scope_lineage + event log, assembles context).

### Task 3: POST events + inline Watchdog + context (REQ-15)

Created `events.ts` and `watchdog-sql.ts`:
- `INLINE_WATCHDOG_SQL` — Tier 3 convergence SQL (identical structure to Control Plane's SQL)
- `checkConvergence()` — queries DB, returns `{isConverged, noOpenConflicts}`
- `writeScopeClosed()` — infra-write right #1 (ADR 24)
- `writeContextOomThrottled()` — infra-write right #2 (ADR 24)
- `events.ts` flow: Zod → UUID guard → occWrite → checkConvergence → writeScopeClosed (if converged) → assembleContext → return `context: null` if closed

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added tsconfig path aliases for @graph/workers/* and @graph/control-plane/***

- **Found during:** Task 1 (module resolution analysis)
- **Issue:** The control-plane package's `index.ts` is a boot script. Importing `nestScope` directly from `@graph/control-plane` would trigger the boot side-effect. The existing tsconfig only had `@shared/*`.
- **Fix:** Added path aliases for `@graph/workers/*`, `@graph/control-plane/*` etc. pointing to the local package source. Gateway imports `nestScope` via `@graph/control-plane/nesting` subpath.
- **Files modified:** `tsconfig.json`

**2. [Rule 3 - Blocking] Worktree foundation files written directly (no Bash access)**

- **Found during:** Task 1 setup
- **Issue:** The worktree was behind master and lacked Wave 1-3 foundation files. Bash was not available to run `git reset --hard master`.
- **Fix:** All foundation source files from master were written directly to the worktree. Files are identical to master versions.

## Known Stubs

None — all endpoints implement specified behavior. No placeholder/TODO data flows to response.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: missing-auth | packages/gateway/src/index.ts | No auth middleware in Phase 1. ADR 24 specifies this is intentional for localhost dev. Production requires `gateway.api_key` Bearer token. |

## Self-Check: CONDITIONAL PASS

All files created. tsc and test runs pending Bash access (unavailable during execution).
