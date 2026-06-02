---
phase: 01-core-graph-engine
plan: "06"
subsystem: queue-adapter-and-frontier-scheduler
tags: [typescript, queue, pg, skip-locked, backpressure, frontier, priority-sql, token-bucket, tdd]
dependency_graph:
  requires: [01-03, 01-05]
  provides:
    - packages/workers/src/queue/queue-adapter.interface.ts
    - packages/workers/src/queue/pg-queue-adapter.ts
    - packages/workers/src/scheduler/token-bucket.ts
    - packages/workers/src/scheduler/frontier.worker.ts
  affects: [01-07, 01-09, 01-10]
tech_stack:
  added: []
  patterns:
    - FOR UPDATE SKIP LOCKED atomic claim queue (ADR 32 D-4)
    - Dedicated pg.Client for LISTEN (not Pool — prevents LISTEN loss on connection recycle)
    - Backpressure via activeWorkerCount vs MAX_PARALLELISM=4 guard
    - Token bucket 50ms window prevents cascade storm (ADR 31)
    - Priority SQL five-term score with typed columns (not JSONB operators)
    - LLM-free dispatch path invariant (ADR 31 D-10)
key_files:
  created:
    - packages/workers/src/queue/queue-adapter.interface.ts
    - packages/workers/src/queue/pg-queue-adapter.ts
    - packages/workers/src/scheduler/token-bucket.ts
    - packages/workers/src/scheduler/frontier.worker.ts
    - src/__tests__/frontier.test.ts
    - tests/integration/queue.test.ts
  modified: []
decisions:
  - "PgQueueAdapter uses Pool.query() for nextEvent() but dedicated new Client() for LISTEN — pool connections are recycled and would drop LISTEN registration (anti-pattern documented in ADR 32)"
  - "IQueueAdapter.onWakeup() callback list (not a single callback) allows multiple dispatch loop registrations"
  - "dynamicScore exported as pure function — enables unit testing the formula without database"
  - "FRONTIER_TRIGGER_CONFIG exported as constant — Plan 09 index.ts owns the registerFunction/registerTrigger calls (single boot entry point, prevents double-registration)"
  - "Queue integration test creates scope partition with stable name execution_event_log_q06_test to avoid collision with other test suites"
  - "vi.useRealTimers() in afterEach prevents fake timer leak into other test suites"
metrics:
  duration: "35 minutes"
  completed: "2026-06-03"
  tasks_completed: 3
  files_created: 6
  tests_written: 18
  tests_passing: "blocked — see Deviations"
requirements_covered: [REQ-17, REQ-18, REQ-19]
---

# Phase 1 Plan 06: PgQueueAdapter + Frontier Scheduler Summary

PgQueueAdapter with FOR UPDATE SKIP LOCKED atomic claim, dedicated pg.Client LISTEN/NOTIFY wakeup, and MAX_PARALLELISM=4 backpressure guard; Frontier Scheduler Worker with five-term priority SQL (typed columns, no JSONB operators), 50ms token-bucket throttle, and pure `dynamicScore` export for unit testing.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | IQueueAdapter + PgQueueAdapter (REQ-17, REQ-18) | blocked | queue-adapter.interface.ts, pg-queue-adapter.ts |
| 2 | Token bucket + Frontier Scheduler Worker (REQ-19) | blocked | token-bucket.ts, frontier.worker.ts, frontier.test.ts |
| 3 | PgQueueAdapter integration test (REQ-17, REQ-18) | blocked | tests/integration/queue.test.ts |

## Verification Results

Verification could not be completed — see Deviations section.

### Expected verification (unblocked):
- `node_modules/.bin/tsc --noEmit` should exit 0 — all files use strict TypeScript with correct imports
- `npm run test:unit -- frontier` should pass — 18 unit tests covering:
  - `dynamicScore(2, 10, 3, 1, 1) === 73` (reference case)
  - age_bonus capped at 20 (ageSec=100 and ageSec=2 produce same age_bonus=20)
  - boundary cases: ageSec=2 (cap), ageSec=1 (below cap)
  - spawned_by_bonus (+3) and active_bonus (+15) independent terms
  - TokenBucket 50ms window (blocks at 49ms, grants at 50ms)
  - FRONTIER_PRIORITY_SQL structural assertions (ORDER BY, LIMIT $2, no JSONB operators)
  - FRONTIER_TRIGGER_CONFIG correct function_id / topic / type

## Deviations from Plan

### Blocking Deviation

**[Rule 3 - Blocking] Bash tool denied — git operations and verification commands unavailable**

- **Found during:** Pre-execution (git reset --hard master step)
- **Issue:** The Bash tool was denied by the execution environment. Without Bash:
  1. `git reset --hard master` could not be run — Wave 1-3 foundation files are not checked out to the worktree working directory.
  2. `node_modules/.bin/tsc --noEmit` cannot be run to verify TypeScript correctness.
  3. `npm run test:unit -- frontier` cannot be run to verify unit tests pass.
  4. `git add` / `git commit` cannot be run for per-task commits.
- **Impact:** All 6 implementation files are written to disk but cannot be type-checked, unit-tested, or committed.
- **Resolution required:** Enable Bash tool access and run from the worktree:
  ```bash
  cd D:\Repo\graph-enginerring\.claude\worktrees\agent-a3edb1feb4f39b793
  git reset --hard master
  node_modules/.bin/tsc --noEmit
  npm run test:unit -- frontier
  # Then commit each task
  ```

## Implementation Summary

### Task 1: IQueueAdapter + PgQueueAdapter

**packages/workers/src/queue/queue-adapter.interface.ts:**
- `IQueueAdapter` interface: `nextEvent(scopeId): Promise<EventLogNode | null>` + `onWakeup(cb): void`
- Phase 2 Redis replacement comment in file header

**packages/workers/src/queue/pg-queue-adapter.ts:**
- `nextEvent()`: `FOR UPDATE SKIP LOCKED LIMIT 1` UPDATE-returning query; short-circuits when `activeWorkerCount >= MAX_PARALLELISM`
- `startListening(connectionString)`: dedicated `new Client()` for `LISTEN graph_event_ready`
- `stopListening()`: cleans up dedicated client
- `activeWorkerCount`: public caller-managed slot counter

### Task 2: TokenBucket + FrontierSchedulerWorker

**packages/workers/src/scheduler/token-bucket.ts:**
- `tryAcquire()`: returns true only when `now - lastGrantMs >= 50`
- `reset()`: useful in tests

**packages/workers/src/scheduler/frontier.worker.ts:**
- `FRONTIER_PRIORITY_SQL`: typed columns (`base_priority`, `unlocks_count`, `spawned_by`, `last_active_at`), `ORDER BY dynamic_score DESC, created_at ASC LIMIT $2`
- `dynamicScore(base, ageSec, unlocks, spawnedBy=0, isActive=0)`: pure export, zero LLM calls (ADR 31)
- `FrontierSchedulerWorker.onFrontierChanged()`: bucket gate → active count → Top-K SQL → DISPATCH_SQL with idempotency guard
- `FRONTIER_TRIGGER_CONFIG`: `{ type: 'durable:subscriber', function_id: 'graph::scheduler::frontier', topic: 'graph::frontier::changed' }`

### Task 3: Queue Integration Test

**tests/integration/queue.test.ts:**
- `describe.skipIf(skipIfNoDb())` — skips cleanly without DATABASE_URL
- Covers: parallel SKIP LOCKED (different IDs), status=processing, null-when-empty, backpressure short-circuit, ON CONFLICT DO NOTHING no-op

## Known Stubs

None. All functionality is fully implemented.

## Threat Flags

None. No new network endpoints. PgQueueAdapter connects outbound only to PostgreSQL.

## Self-Check

Files written to disk (verified via worktree filesystem):
- FOUND: packages/workers/src/queue/queue-adapter.interface.ts
- FOUND: packages/workers/src/queue/pg-queue-adapter.ts
- FOUND: packages/workers/src/scheduler/token-bucket.ts
- FOUND: packages/workers/src/scheduler/frontier.worker.ts
- FOUND: src/__tests__/frontier.test.ts
- FOUND: tests/integration/queue.test.ts

Commits: BLOCKED (Bash denied)
tsc: BLOCKED (Bash denied)
Tests: BLOCKED (Bash denied)

## Self-Check: PARTIAL
