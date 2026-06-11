---
phase: 03-pattern-discovery
plan: "04"
subsystem: control-plane
tags: [nested-scopes, sub_scope_resolved, pulse-fetch, adr-23, adr-12, gate4-3]
dependency_graph:
  requires: [03-01]
  provides: [GATE4-3-control-plane-half]
  affects: [03-06-SubScopeResultWorker]
tech_stack:
  added: []
  patterns:
    - Control Plane direct-write for sub_scope_resolved (same class as context_oom_throttled)
    - pgcrypto digest() version_hash in SQL — version_hash never computed in TypeScript
    - Exported topic constant (SUB_SCOPE_TOPIC) for cross-plan import safety
key_files:
  created:
    - packages/control-plane/src/nesting.test.ts
  modified:
    - packages/control-plane/src/nesting.ts
    - packages/control-plane/src/pulse-fetch.ts
decisions:
  - "triggerTaskId is not stored in scope_lineage (no column in migration 005); caller passes it to resolveSubScope at close time"
  - "SUB_SCOPE_TOPIC exported from pulse-fetch.ts so Plan 03-06 imports identical string"
  - "resolveSubScope falls back to ZERO_HASH if child partition has no events (defensive; should not happen in practice)"
metrics:
  duration_minutes: 12
  completed_date: "2026-06-05"
  tasks_completed: 2
  files_changed: 3
---

# Phase 3 Plan 4: Nested Scope Activation — Control Plane Half Summary

**One-liner:** Control Plane direct-writes sub_scope_resolved to parent partition via pgcrypto digest() after child scope closes, routed by Pulse-Fetch to graph::scope::sub_scope_resolved topic (ADR 23 GATE4-3 Control Plane half).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Sub-scope creation + sub_scope_resolved injection in nesting.ts | 419d8eb | packages/control-plane/src/nesting.ts, packages/control-plane/src/nesting.test.ts |
| 2 | Route sub_scope_resolved to dedicated topic in pulse-fetch.ts | 91babeb | packages/control-plane/src/pulse-fetch.ts |

## What Was Built

### Task 1 — nesting.ts extension

Added two exported functions:

**`createSubScope(ddlPool, intent, parentScopeId, triggerTaskId, depth)`**
- Delegates to existing `nestScope()` for the full 3-phase DDL protocol (CREATE PARTITION + scope_lineage INSERT + plan_created event)
- `triggerTaskId` is NOT stored in `scope_lineage` (migration 005 has no such column — the ADR 23 draft schema differs from the real schema)
- `triggerTaskId` is carried by the caller and passed to `resolveSubScope` at close time
- Depth enforcement inherited from `nestScope` (throws if `depth > MAX_CHILD_SCOPE_DEPTH`)

**`resolveSubScope(pool, childScopeId, triggerTaskId)`**
- Queries `scope_lineage` for `parent_scope_id`; returns (no-op) if NULL (root scope)
- Reads child's tail `version_hash` (last row by `id DESC`)
- Direct-writes `sub_scope_resolved` to parent partition following the `watchdog.ts` `context_oom_throttled` pattern exactly: predecessor_hash = parent's tail, version_hash via `pgcrypto digest()` in SQL
- Payload: `{ child_scope_id, trigger_task_id, child_final_version_hash, parent_scope_id }`
- Does NOT go through `occWrite` or the bus enum (ADR 12 unchanged)

**`nesting.test.ts`** (4 cases):
- (a) DB-gated: createSubScope creates child with parent_scope_id set and depth=1
- (b) Mock: createSubScope at depth > MAX_CHILD_SCOPE_DEPTH throws (no DB needed)
- (c) DB-gated: resolveSubScope writes exactly one sub_scope_resolved row with correct payload keys
- (d) DB-gated: resolveSubScope on root scope writes zero rows

### Task 2 — pulse-fetch.ts routing

- Exported `SUB_SCOPE_TOPIC = 'graph::scope::sub_scope_resolved'` — Plan 03-06 imports this constant rather than duplicating the string
- Added routing branch in both the **replay loop** and the **NOTIFY handler**: `event_type === 'sub_scope_resolved'` triggers `SUB_SCOPE_TOPIC`, all other event types continue routing to `graph::scheduler::frontier`
- sub_scope_resolved rows are never dispatched as frontier nodes to FrontierScheduler

## Verification

| Check | Result |
|-------|--------|
| `npm run typecheck` | Passes (0 errors) |
| `npx vitest run packages/control-plane/src` | 1 passed, 3 skipped (DB-gated) |
| `grep -c "sub_scope_resolved" packages/control-plane/src/nesting.ts` | 11 |
| `grep -c "sub_scope_resolved" packages/shared/src/constants.ts` | 0 (ADR 12 invariant) |
| `grep -c "graph::scope::sub_scope_resolved" packages/control-plane/src/pulse-fetch.ts` | 1 |
| EVENT_TYPES members | Still exactly 5 (plan_created, task_spawned, memory_updated, conflict_detected, scope_closed) |

## ADR Compliance

- **ADR 12**: EVENT_TYPES enum unchanged — `sub_scope_resolved` NOT added; confirmed `grep -c "sub_scope_resolved" packages/shared/src/constants.ts` = 0
- **ADR 23**: sub_scope_resolved is a Control Plane direct-write; Control Plane is sole legal writer; bypasses bus enum (same class as context_oom_throttled per ADR 13 supplement)
- **ADR 02**: version_hash computed via `pgcrypto digest()` in SQL — never in TypeScript
- **ADR 05**: `createSubScope` delegates to `nestScope` which runs full 3-phase DDL transaction

## Deviations from Plan

### Auto-fixed Issue (Reconciliation)

**ADR 23 schema vs. real schema mismatch:**
- Found during: Task 1 read phase
- Issue: ADR 23 §1 shows `scope_lineage` with columns `child_scope_id`, `parent_scope_id`, `trigger_task_id` — but migration 005 uses `scope_id`, `parent_scope_id`, `depth`, `intent`, `status` (no `trigger_task_id` column)
- Fix: `triggerTaskId` is NOT stored in DB; carried by the caller and passed to `resolveSubScope` at close time; embedded only in the `sub_scope_resolved` payload
- Decision documented in `.harness/implementation-notes.md` per plan specification

No other deviations — plan executed as written.

## Known Stubs

None. Both functions are fully implemented. The DB-gated tests will execute when `DATABASE_URL` is set in the Gate 4 integration test run (Plan 03-07).

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| threat_flag: elevation-of-privilege | packages/control-plane/src/nesting.ts | createSubScope depth param is caller-controlled; nestScope enforces MAX_CHILD_SCOPE_DEPTH before any DDL (T-03-04-01 mitigated) |
| threat_flag: ddl-injection | packages/control-plane/src/nesting.ts | createSubScope delegates to nestScope which calls assertSafeUuidHex before partition name interpolation (T-03-04-03 mitigated) |

## Self-Check: PASSED

- [x] packages/control-plane/src/nesting.ts exists and contains createSubScope + resolveSubScope
- [x] packages/control-plane/src/nesting.test.ts exists with 4 test cases
- [x] packages/control-plane/src/pulse-fetch.ts exports SUB_SCOPE_TOPIC and routing branch
- [x] Commit 419d8eb: feat(03-04): nesting.ts — createSubScope + resolveSubScope
- [x] Commit 91babeb: feat(03-04): pulse-fetch routes sub_scope_resolved to dedicated topic
- [x] typecheck passes
- [x] vitest passes (1 passed, 3 skipped without DB)
