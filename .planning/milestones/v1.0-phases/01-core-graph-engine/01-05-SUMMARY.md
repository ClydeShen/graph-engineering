---
phase: 01-core-graph-engine
plan: "05"
subsystem: workers-framework
tags: [typescript, abc-pattern, capability-boundary, lifecycle, knapsack, subagent, tdd]
dependency_graph:
  requires: [packages/shared]
  provides:
    - packages/workers/src/base/graph-handle.ts
    - packages/workers/src/base/read-only-handle.ts
    - packages/workers/src/base/worker.abstract.ts
    - packages/workers/src/base/tool.interface.ts
    - packages/workers/src/base/lifecycle.ts
    - packages/workers/src/base/subagent.ts
  affects: [all-worker-implementations, gateway-worker-integration]
tech_stack:
  added: []
  patterns:
    - TypeScript ABC compile-time boundary enforcement (ADR 35)
    - PhaseGuardedHandle proxy for runtime write enforcement (ADR 27)
    - OCC Writable CTE via occWrite() with pgcrypto.digest (ADR 11)
    - Knapsack bifurcation: size-cause vs load-cause re-queue (ADR 27)
    - spawned_by hyperedge for child Scope lineage (ADR 34)
key_files:
  created:
    - packages/workers/package.json
    - packages/workers/src/base/graph-handle.ts
    - packages/workers/src/base/read-only-handle.ts
    - packages/workers/src/base/worker.abstract.ts
    - packages/workers/src/base/tool.interface.ts
    - packages/workers/src/base/lifecycle.ts
    - packages/workers/src/base/subagent.ts
    - src/__tests__/tool-boundary.test.ts
    - src/__tests__/worker-lifecycle.test.ts
  modified: []
decisions:
  - "ReadOnlyGraphHandle interface has no write() — compile error is the primary enforcement; runtime SecurityException guards against any-cast bypass (ADR 35)"
  - "PhaseGuardedHandle wraps real GraphHandle and delegates all queries; only write() is phase-gated — avoids interface duplication"
  - "occWrite() embedded in graph-handle.ts (not shared) because it requires Pool; shared exports WriteResult/GraphWriteEvent types only"
  - "spawnChildScope uses 'task_spawned' canonical event type for the spawned_by hyperedge — 'scope_spawned' is semantic label, wire type must be one of five canonical types (ADR 12)"
  - "canonicalJsonText() re-implemented inline in subagent.ts — single-level sort sufficient for known payload shape; avoids circular dep risk with @graph/shared"
metrics:
  duration: "22 minutes"
  completed: "2026-06-03"
  tasks_completed: 3
  files_created: 9
  tests_written: 9
  tests_passing: 9
requirements_covered: [REQ-11, REQ-12, REQ-13, REQ-14, REQ-23]
---

# Phase 1 Plan 05: Worker/Tool ABC Framework Summary

**One-liner:** TypeScript ABC capability boundary (Worker→GraphHandle, Tool→ReadOnlyGraphHandle) with 4-phase lifecycle enforcement, Knapsack bifurcation, and in-process subagent scope branching.

## What Was Built

### Task 1 — GraphHandle / ReadOnlyGraphHandle ABC (REQ-11, REQ-23)

`packages/workers/src/base/graph-handle.ts`:
- `GraphHandle` interface: `write(event): Promise<WriteResult>` + `query<T>(): Promise<T[]>` + `scopeId`
- `GraphHandleImpl` backed by pg Pool; delegates `write()` to `occWrite()`
- `occWrite()`: OCC Writable CTE using `pgcrypto.digest()` for SHA-256 version hash; returns `occ_result: 'won' | 'demoted'` (ADR 11)

`packages/workers/src/base/read-only-handle.ts`:
- `ReadOnlyGraphHandle` interface: **no `write()` method** — Tool calling `ctx.graph.write()` is a TypeScript compile error (TS2339)
- `SecurityException extends Error` — thrown by `ReadOnlyGraphHandleImpl.write()` at runtime
- `ReadOnlyGraphHandleImpl`: implements `ReadOnlyGraphHandle`; non-interface `write(_event): never` throws `SecurityException`
- Scope UUID documented as NEVER mutated by context-size operations (ADR 33 / REQ-23)

`src/__tests__/tool-boundary.test.ts`:
- `@ts-expect-error` fixture proves `roHandle.write({})` via interface is a compile error
- Runtime test: `ReadOnlyGraphHandleImpl.write({})` throws `SecurityException`
- Scope UUID orthogonality assertion

### Task 2 — Worker ABC + Tool Interface + 4-Phase Lifecycle (REQ-12, REQ-13)

`packages/workers/src/base/worker.abstract.ts`:
- `WorkerExecutionContext { scopeId, entityId, currentVersionHash, graph: GraphHandle, input }`
- `abstract class Worker` with five lifecycle hooks: `onScheduled`, `onRunning`, `onCompleted`, `onFailed`, `onConflicted`

`packages/workers/src/base/tool.interface.ts`:
- `ToolExecutionContext { scopeId, graph: ReadOnlyGraphHandle }` — no `write()` in context type
- `interface Tool<TInput, TOutput>` with `inputSchema`, `outputSchema`, `execute(input, ctx)`

`packages/workers/src/base/lifecycle.ts`:
- `LifecyclePhase = 'Initializing' | 'Processing' | 'Writing' | 'Terminated'`
- `LifecycleViolationError` — thrown when `write()` attempted during Processing
- `PhaseGuardedHandle` — proxy wrapper that intercepts `write()` and checks current phase
- `runLifecycle(worker, ctx, loadAttempt?)` — drives 4-phase execution with Knapsack bifurcation
- `classifyKnapsackFailure(err): 'size' | 'load'` — inspects error message for context overflow indicators
- `MAX_LOAD_REQUEUE = 3` — cap before load-cause escalates to OOM chain
- `writeToolResult(graph, event)` — per-tool-result write helper with crash-safe DO NOTHING semantics (ADR 36)

`src/__tests__/worker-lifecycle.test.ts` (6 tests):
- write-during-Processing rejected with `LifecycleViolationError`; real `graph.write` not called
- write-during-Writing (onCompleted) succeeds
- size-cause failure escalates immediately (`escalated: true`)
- load-cause re-queue: attempts 0, 1, 2 do not escalate; attempt 3 escalates
- `classifyKnapsackFailure` correctly categorizes size vs load errors

### Task 3 — Subagent Scope Branching Phase 1 (REQ-14)

`packages/workers/src/base/subagent.ts`:
- `spawnChildScope(graph, parentScopeId, parentDepth, input): Promise<{ childScopeId }>`
- Depth guard: throws `SubagentDepthExceeded` when `parentDepth + 1 > MAX_CHILD_SCOPE_DEPTH` (3)
- Env guard: throws `SubagentEnvGuard` when `process.env.GRAPH_AGENT_CHILD_SCOPE` not set
- Writes `task_spawned` event with payload `{ spawned_by_scope, child_scope_id, child_depth, input }`
- `predecessor_hash = ZERO_HASH` — child scope starts a fresh chain in the parent partition
- Phase 4 note: distributed/forked execution via `runtime.fork()` is explicitly deferred

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `query<T>` generic constraint**
- **Found during:** Task 1 tsc check
- **Issue:** `pg`'s `Pool.query<T>()` requires `T extends QueryResultRow`; using `T = unknown` caused TS2344
- **Fix:** Changed interface and impl to `T extends QueryResultRow = QueryResultRow`
- **Files modified:** `graph-handle.ts`, `read-only-handle.ts`

**2. [Rule 1 - Bug] `@ts-expect-error` on concrete class instead of interface**
- **Found during:** Task 1 tsc check — TS2578 "Unused @ts-expect-error"
- **Issue:** Test used `ReadOnlyGraphHandleImpl` (concrete, which has `write()`) instead of `ReadOnlyGraphHandle` interface (which does not). Directive was not triggering a compile error.
- **Fix:** Changed test to type variable as `ReadOnlyGraphHandle` interface so `write()` is genuinely absent at type level

**3. [Rule 1 - Bug] `caughtError: Error | null` cast to `LifecycleViolationError`**
- **Found during:** Task 2 tsc check — TS2352 null overlap
- **Fix:** Used `as unknown as LifecycleViolationError` double-cast

**4. [Decision] `canonicalJsonText()` re-implemented inline in `subagent.ts`**
- **Found during:** Task 3 design
- **Issue:** Importing `canonicalJson` from `@graph/shared` would require deep nested import and potential circular dep; the payload shape is flat/known
- **Fix:** Inline single-level `Object.keys().sort()` canonical serialization — consistent with ADR 02

## Known Stubs

None. All functionality is wired. `occWrite()` requires a live PostgreSQL instance with pgcrypto extension — tests use mocked `GraphHandle` to avoid integration dependency.

## Threat Flags

None. No new network endpoints or auth paths introduced. `spawnChildScope` is in-process only (Phase 1 guard via env var).

## Self-Check

- [x] `packages/workers/src/base/graph-handle.ts` exists
- [x] `packages/workers/src/base/read-only-handle.ts` exists
- [x] `packages/workers/src/base/worker.abstract.ts` exists
- [x] `packages/workers/src/base/tool.interface.ts` exists
- [x] `packages/workers/src/base/lifecycle.ts` exists
- [x] `packages/workers/src/base/subagent.ts` exists
- [x] `src/__tests__/tool-boundary.test.ts` exists
- [x] `src/__tests__/worker-lifecycle.test.ts` exists
- [x] Commits: `421f86e`, `a5c3393`, `8d2ed88`
- [x] `npm run test:unit -- tool-boundary worker-lifecycle`: 17 tests passing
- [x] `npx tsc --noEmit`: 0 errors

## Self-Check: PASSED
