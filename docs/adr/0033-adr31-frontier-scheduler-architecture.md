# ADR 31: Frontier Scheduler Architecture

**Status:** Accepted  
**Date:** 2026-06-01  
**Supplements:** ADR 28 (Scheduling Spec and Operational Determinism)

## Context

ADR 28 defines `Max_Parallelism` and the convergence algebra but does not specify how pending frontier nodes are selected for dispatch, or how the scheduler avoids cascade storms when multiple Workers complete in rapid succession. The iii engine is FIFO-only — all priority logic must live outside iii. A formal scheduler architecture is required before Phase 1 to ensure the `Max_Parallelism = 4` constraint is enforced correctly and that burst completions do not cause a self-reinforcing dispatch flood.

## Decision

`graph::scheduler` (FrontierSchedulerWorker) implements an event-triggered micro-batching loop with a token-bucket throttle (ADR 28.1 amendment). Priority is computed entirely in a PostgreSQL Top-K SQL query. iii's FIFO delivery is used as the transport; all ordering logic is in the scheduler Worker, not in iii.

## Mechanism

### Scheduler Worker Registration

```typescript
sdk.registerFunction(
  "graph::scheduler::frontier",
  async (data: FrontierChangedEvent) => {
    // Subscribed to: graph::frontier::changed (durable:subscriber)
    // Internally maintains a token-bucket throttled execution loop
    await frontierScheduler.onFrontierChanged(data);
  }
);
```

### Event-Triggered Micro-Batching with Backpressure Throttle (B+A hybrid)

The scheduler does NOT dispatch on every individual `graph::frontier::changed` event. It batches within a 50ms token-bucket window:

```
Token bucket:
  capacity = 1 dispatch cycle per 50ms window
  On each window tick:
    1. Execute Top-K SQL query (see below)
    2. Emit pending_dispatch updates for up to Max_Parallelism_remaining Workers
    3. Reset bucket
```

This prevents cascade storms: if 4 Workers complete simultaneously and each emits a `frontier::changed` event, the scheduler fires once (not 4 times) per 50ms window.

### ADR 28.1 Amendment — Priority SQL Operator

```sql
WITH frontier_nodes AS (
  SELECT 
    id, entity_id, event_type, created_at,
    (payload->>'priority')::int AS base_priority,
    (payload->>'unlocks_count')::int AS unlocks_count,
    LEAST(EXTRACT(EPOCH FROM (NOW() - created_at)) * 10, 20) AS age_bonus
  FROM execution_event_log
  WHERE status = 'pending_scheduling' AND scope_id = $1
)
SELECT id, entity_id,
  (base_priority * 10 + age_bonus + unlocks_count * 5) AS dynamic_score
FROM frontier_nodes
ORDER BY dynamic_score DESC, created_at ASC
LIMIT $2; -- Max_Parallelism_remaining
```

**Score formula:**
```
dynamic_score = (base_priority × 10) + age_bonus + (unlocks_count × 5)
```

**Key invariants:**

| Invariant | Mechanism |
|-----------|-----------|
| Priority inversion is mathematically impossible | `age_bonus` is capped at 20 via `LEAST(...)`. The minimum inter-priority gap is 10 points (1 priority level × 10). A task with lower priority can never accumulate enough age bonus (max 20) to overtake a task that is 2+ priority levels higher (min 20-point gap). |
| Equal-score tasks resolve to local FIFO | `ORDER BY dynamic_score DESC, created_at ASC` — oldest task wins on tie |
| All priority logic lives in PostgreSQL | iii is FIFO-only; the scheduler Worker owns the Top-K query |
| Cascade storm prevention | Token-bucket window prevents re-triggering on every Worker state change event |

### `Max_Parallelism_remaining` Computation

```typescript
const activeWorkers = await ctx.graph.query(
  `SELECT COUNT(*) FROM execution_event_log 
   WHERE status IN ('processing', 'writing') 
   AND scope_id = $1`,
  [scopeId]
);
const remaining = MAX_PARALLELISM - activeWorkers;
// LIMIT $2 in the SQL query receives `remaining`
```

When `remaining = 0`, the scheduler skips the Top-K query entirely and waits for the next `frontier::changed` event.

### `pending_dispatch` State Transition

After selecting Top-K nodes, the scheduler atomically marks them:

```sql
UPDATE execution_event_log
SET status = 'pending_dispatch', scheduled_at = NOW()
WHERE id = ANY($selected_ids)
  AND status = 'pending_scheduling'; -- guard against double-dispatch
```

The `AND status = 'pending_scheduling'` guard makes the update idempotent — if the scheduler fires twice within the same window (race condition), the second update is a no-op.

## Consequences

### Positive
- Token-bucket micro-batching prevents cascade storms during burst Worker completions.
- Priority SQL is transparent, auditable, and testable without iii internals.
- Mathematical proof that priority inversion is impossible (age_bonus cap = 20 < min inter-priority gap = 10 × priority_level).
- `unlocks_count` signal rewards tasks that unblock many downstream nodes, improving overall throughput.

### Negative / Trade-offs
- 50ms batching window introduces a fixed scheduling latency floor. Ultra-low-latency tasks (sub-50ms) cannot be dispatched faster than the window.
- Scheduler is a Worker itself — it consumes one of the 4 `Max_Parallelism` slots while running. Phase 2 may need to exempt it from the slot count.
- `pending_scheduling` status is a new state added to `execution_event_log` not present in ADR 12's five canonical events — this is a scheduler-internal infrastructure status, not a cognitive event, and does not enter the enumeration.

## References
- ADR 27 — Worker lifecycle (four phases; scheduler transitions nodes through `pending_scheduling → pending_dispatch → processing`)
- ADR 28 — Scheduling spec (`Max_Parallelism` formula, convergence algebra)
- ADR 32 — PgQueueAdapter (delivers `pending_dispatch` rows to Workers via `FOR UPDATE SKIP LOCKED`)
