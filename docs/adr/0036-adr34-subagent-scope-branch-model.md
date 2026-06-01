# ADR 34: Subagent Execution and Scope Branch Model

**Status:** Accepted  
**Date:** 2026-06-01  
**Supplements:** ADR 23 (Nested Scope Propagation), ADR 33 (Scope Identity Boundary)

## Context

Workers need to spawn sub-Workers for task delegation (e.g., a planning Worker handing off a subtask to a specialized execution Worker). ADR 23 defines the nested Scope propagation protocol for Phase 3, but Phase 1 needs a concrete in-process implementation that does not require distributed infrastructure. Additionally, recursive spawning (a Worker spawning itself infinitely) must be prevented at the framework level before Phase 1. This ADR defines the Phase 1 in-process Scope branch model and the Phase 2 path to multi-node distribution.

## Decision

Phase 1 uses in-process Scope branches: child Workers execute in the same iii process as the parent, linked via a `spawned_by` Hyper-edge. A dual-layer recursion guard (environment variable + payload field) prevents infinite recursion. Phase 2 extends to multi-node distribution transparently — the `spawned_by` Hyper-edge topology remains unchanged.

## Mechanism

### Phase 1: Scope Branches (Same Process)

**Spawning sequence:**

```typescript
// Inside a parent Worker's onRunning():
async function spawnChildScope(
  ctx: WorkerExecutionContext,
  childInput: WorkerInput
): Promise<ChildScopeHandle> {
  // Step 1: Create child Scope UUID
  const childScopeId = generateUUID();

  // Step 2: Append spawned_by Hyper-edge to the graph
  await ctx.graph.write({
    event_type: 'scope_spawned',
    entity_id: childScopeId,
    payload: {
      entity_type: 'scope',
      spawned_by_scope: ctx.scopeId,
      spawned_by_version: ctx.currentVersionHash,
      child_input: childInput,
    },
    predecessor_hash: ctx.currentVersionHash,
  });

  // Step 3: Hyper-edge record in hyper_edges table
  // (parent_scope_id, child_scope_id, "scope_spawned", version_hash, timestamp)

  // Step 4: Set recursion guard env before spawning
  process.env.GRAPH_AGENT_CHILD_SCOPE = ctx.scopeId;

  // Step 5: Dispatch child Worker within child Scope
  const handle = await sdk.trigger({
    function_id: childInput.workerType,
    payload: {
      ...childInput,
      spawned_by_scope: ctx.scopeId,  // Layer 2: payload field
    },
    scope_id: childScopeId,
  });

  return handle;
}
```

**Hyper-edge structure for scope spawning:**
```
(parent_scope_id, child_scope_id, "scope_spawned", version_hash, timestamp)
```

This is the canonical parent-child record. The `spawned_by` relationship is always readable from the graph by querying Hyper-edges with `event_type = 'scope_spawned'` and `target_id = child_scope_id`.

**Await vs fire-and-forget:**

```typescript
// Option A: Parent awaits child completion
const result = await handle.waitForCompletion();

// Option B: Fire-and-forget (parent continues independently)
await handle.void(); // TriggerAction.Void()
```

### Interrupt Propagation

When a child Scope must be interrupted (e.g., parent is cancelled, timeout):

```typescript
// Control plane emits scope_interrupted on child Scope
await ctx.graph.write({
  event_type: 'scope_interrupted',
  entity_id: childScopeId,
  payload: { reason: 'parent_cancelled', parent_scope_id: ctx.scopeId },
  predecessor_hash: childCurrentVersionHash,
});
```

FrontierSchedulerWorker (ADR 31) filters interrupted Scopes from dispatch:

```sql
-- ADR 31 Top-K query amended with interrupt filter:
WHERE status = 'pending_scheduling' 
  AND scope_id = $1
  AND scope_id NOT IN (
    SELECT entity_id FROM execution_event_log
    WHERE event_type = 'scope_interrupted'
  )
```

In-flight Workers in the interrupted Scope complete their current graph write (maintaining append-only invariant) and then stop — they check the interrupt flag at the start of each `onRunning()` iteration.

### Dual-Layer Recursion Guard

Infinite recursion (a Worker spawning itself, spawning itself, ...) is prevented at two layers:

**Layer 1 — Environment variable (process boundary):**
```typescript
// Set before spawning any child Worker
process.env.GRAPH_AGENT_CHILD_SCOPE = parentScopeId;

// Child Worker checks on startup (onScheduled):
if (process.env.GRAPH_AGENT_CHILD_SCOPE === ctx.scopeId) {
  throw new Error(`RecursionGuard: Worker ${ctx.workerType} attempted to spawn itself`);
}
```

**Layer 2 — Payload field (cross-process boundary):**
```typescript
// All spawned Workers receive this in their input payload:
interface WorkerInput {
  spawned_by_scope?: string;  // UUID of parent Scope, if this is a child Worker
}

// Worker checks on startup (onScheduled):
if (input.spawned_by_scope === ctx.scopeId) {
  throw new Error(`RecursionGuard: circular spawning detected`);
}
```

The dual-layer guard is required because Phase 2 crosses process boundaries where environment variables do not propagate. The payload field is the cross-process guard; the env var is the single-process guard.

**Maximum nesting depth:** Phase 1 enforces `MAX_CHILD_SCOPE_DEPTH = 3` via a `depth` counter in the payload (incremented on each spawn). Workers refuse to spawn children if `depth >= MAX_CHILD_SCOPE_DEPTH`.

### Phase 2: Multi-Node Distribution

In Phase 2, the child Scope runs on a separate iii-SDK process with an independent WebSocket connection to the iii engine. The Scope model is unchanged:

- `spawned_by` Hyper-edge still the canonical parent-child record in PostgreSQL
- Child process receives its `scope_id` and `spawned_by_scope` via the payload
- Pattern discovery (ADR 25, ADR 37) reads topology from the graph — process boundaries are invisible
- The `GRAPH_AGENT_CHILD_SCOPE` env var is propagated via process spawn arguments (Phase 2 implementation detail)

```
Phase 1:                          Phase 2:
┌─────────────────────────────┐   ┌──────────────┐   ┌──────────────┐
│ iii process                 │   │ iii process  │   │ iii process  │
│  Parent Worker (scope A)    │   │  Parent      │   │  Child       │
│  Child Worker  (scope B)    │   │  (scope A)   │   │  (scope B)   │
│  [same process]             │   │              │   │  [separate]  │
└─────────────────────────────┘   └──────────────┘   └──────────────┘
         Both: spawned_by Hyper-edge in PostgreSQL (unchanged)
```

## Consequences

### Positive
- In-process Phase 1 implementation requires no distributed infrastructure (no inter-process RPC, no message broker beyond iii's existing WebSocket).
- `spawned_by` Hyper-edge makes the parent-child relationship a first-class graph citizen — it is queryable, traceable, and participates in pattern discovery.
- Dual-layer recursion guard is fail-safe across process boundaries (Phase 2 compatible).
- Phase 2 is transparent to pattern discovery — the topology is in the graph, not the process.

### Negative / Trade-offs
- In Phase 1, a child Worker that crashes takes down the parent process (same-process constraint). Phase 2 isolates this with separate processes.
- `MAX_CHILD_SCOPE_DEPTH = 3` is a conservative Phase 1 limit. Deep delegation chains (e.g., planning → execution → sub-execution → sub-sub-execution) require Phase 2's multi-node model.
- The `scope_interrupted` filter in ADR 31's scheduler SQL adds a `NOT IN` subquery — acceptable at `Max_Parallelism = 4` scale, but may need indexing at Phase 2 scale.

## References
- ADR 23 — Nested Scope propagation protocol (Phase 3 full mechanism)
- ADR 27 — Worker lifecycle (interrupt handling in `onScheduled` / `onFailed`)
- ADR 28 — `Max_Parallelism` (child Workers count toward the same limit in Phase 1)
- ADR 31 — Frontier Scheduler (interrupt filter SQL amendment)
- ADR 33 — Scope Identity Boundary (`spawned_by` is a legitimate Scope UUID creation path)
