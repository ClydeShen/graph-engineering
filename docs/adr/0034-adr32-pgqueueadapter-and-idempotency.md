# ADR 32: PgQueueAdapter and Idempotency Enforcement

**Status:** Accepted  
**Date:** 2026-06-01  
**Supplements:** ADR 09 (LISTEN/NOTIFY Pulse-Fetch), ADR 11 (Worker Idempotency and OCC)

## Context

iii's built-in adapter polls for work every 100ms using a file-based queue. This polling interval creates unnecessary latency and introduces a queue store that is physically separate from the Execution Graph, risking dual-write inconsistency. Separately, iii's at-least-once delivery guarantee means Workers may receive duplicate events after crash or network partition. ADR 11 addresses idempotency at the OCC level (Writable CTE), but a complementary database-level unique constraint is needed to make duplicate delivery a silent no-op at the storage layer without requiring Workers to implement custom deduplication logic.

## Decision

Replace iii's built-in 100ms-poll file-based adapter with a PostgreSQL `FOR UPDATE SKIP LOCKED` queue (PgQueueAdapter). Worker idempotency against at-least-once redelivery is enforced via `UNIQUE(scope_id, entity_id, version_hash)` constraints on `hyper_edges` and `versions` tables, combined with `ON CONFLICT DO NOTHING` in all Worker write paths.

## Mechanism

### D-4: PgQueueAdapter (Phase 1)

**Atomic claim — dispatch one pending event:**

```sql
UPDATE execution_event_log
SET status = 'processing', dispatched_at = NOW()
WHERE id = (
  SELECT id 
  FROM execution_event_log
  WHERE status = 'pending_dispatch' AND scope_id = $1
  ORDER BY event_id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING id, event_type, entity_id, payload, predecessor_hash;
```

`FOR UPDATE SKIP LOCKED` ensures two Workers racing to claim the same event are serialized at the database level — the loser skips to the next unclaimed row rather than blocking. This is the correct PostgreSQL pattern for queue consumers.

**TypeScript adapter interface:**

```typescript
interface IQueueAdapter {
  nextEvent(scopeId: string): Promise<EventLogNode | null>;
}

class PgQueueAdapter implements IQueueAdapter {
  private static readonly BACKOFF_MAX_MS = 50;

  async nextEvent(scopeId: string): Promise<EventLogNode | null> {
    const result = await this.pool.query(
      `UPDATE execution_event_log
       SET status = 'processing', dispatched_at = NOW()
       WHERE id = (
         SELECT id FROM execution_event_log
         WHERE status = 'pending_dispatch' AND scope_id = $1
         ORDER BY event_id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING id, event_type, entity_id, payload, predecessor_hash`,
      [scopeId]
    );
    return result.rows[0] ?? null;
  }
}
```

**LISTEN/NOTIFY integration (wakeup signal only):**

LISTEN/NOTIFY is used as a wakeup signal — no data is carried in the notification payload. The notification merely wakes the adapter loop; the actual event data is always fetched via the `FOR UPDATE SKIP LOCKED` query. This preserves ADR 09's invariant (NOTIFY carries only `{"id": $event_id}`, max 64 bytes) and avoids bypassing iii delivery guarantees.

```typescript
// Adapter loop (simplified)
await this.pgClient.query('LISTEN graph_event_ready');
this.pgClient.on('notification', async () => {
  const event = await this.nextEvent(scopeId);
  if (event) await this.dispatchToWorker(event);
});
```

**Why not Redis (Phase 1) — rationale:**

| Concern | PostgreSQL SKIP LOCKED | Redis |
|---------|----------------------|-------|
| Additional infrastructure | None — same PostgreSQL instance | Requires Redis deployment |
| Queue state vs graph state | Same transaction, same DB | Dual-write consistency risk |
| 100ms poll latency | Eliminated by LISTEN/NOTIFY wakeup | Sub-ms, but adds infra |
| Phase 2 swap cost | `IQueueAdapter` abstraction isolates change | Swap touches only the adapter |

Phase 2 Redis interface is pre-reserved via the `IQueueAdapter` abstraction — swapping is a single implementation replacement.

**Backpressure:**

When all 4 Worker sandboxes are occupied (active Workers = `Max_Parallelism`), no `nextEvent()` calls are made. `pending_dispatch` rows wait silently in PostgreSQL. Storage is the backpressure buffer — no in-memory queue, no dropped events, no back-pressure protocol overhead.

### D-5: Idempotency via UNIQUE Constraint

**Schema constraints:**

```sql
-- On hyper_edges table:
ALTER TABLE hyper_edges 
ADD CONSTRAINT uk_hyper_edges_idempotency 
UNIQUE(scope_id, entity_id, version_hash);

-- On versions table:
ALTER TABLE versions 
ADD CONSTRAINT uk_versions_idempotency 
UNIQUE(scope_id, entity_id, version_hash);
```

**Worker write pattern (all Workers must use this form):**

```sql
INSERT INTO hyper_edges (scope_id, source_id, target_id, event_type, version_hash, timestamp, payload)
VALUES ($1, $2, $3, $4, $5, NOW(), $6)
ON CONFLICT (scope_id, entity_id, version_hash) DO NOTHING;
```

The Version Hash (computed per ADR 02's canonical JSON formula) is the idempotency key. If iii redelivers an event and a Worker attempts to write the same Version Hash again, `ON CONFLICT DO NOTHING` makes the duplicate write a silent no-op. The Worker's return value still indicates `won` (the original write succeeded on first delivery) — the duplicate delivery is transparent.

**Interaction with ADR 03 OCC (Writable CTE):**

The UNIQUE constraint and `ON CONFLICT DO NOTHING` operate at the storage layer. ADR 03's Writable CTE OCC operates at the business logic layer (concurrent Workers competing to advance the same entity version). These are complementary — OCC handles live concurrency, UNIQUE handles replay idempotency.

| Scenario | Handled by |
|----------|-----------|
| Two Workers race to write different payloads to the same entity | ADR 03 OCC (Writable CTE) |
| iii redelivers the same event after crash | ADR 32 UNIQUE + ON CONFLICT DO NOTHING |
| Scheduler emits `pending_dispatch` twice for the same row | ADR 31 scheduler guard (`AND status = 'pending_scheduling'`) |

## Consequences

### Positive
- Eliminates the 100ms poll bottleneck with zero additional infrastructure.
- Queue state lives in the same PostgreSQL transaction as graph state — no dual-write consistency gap possible.
- `ON CONFLICT DO NOTHING` makes at-least-once redelivery transparent to Worker authors — no custom deduplication logic required.
- `IQueueAdapter` abstraction enables Phase 2 Redis swap without modifying any Worker code.

### Negative / Trade-offs
- `FOR UPDATE SKIP LOCKED` holds a short-lived row lock. Under extremely high concurrency (many Workers claiming from the same Scope simultaneously), lock contention is possible. Mitigated by `Max_Parallelism = 4` hard cap.
- `ON CONFLICT DO NOTHING` silently discards duplicate writes — if a duplicate arises from a bug (not from iii redelivery), the bug is masked. Worker authors must not rely on `DO NOTHING` to cover logic errors.
- LISTEN/NOTIFY wakeup requires a persistent PostgreSQL connection per adapter instance.

## References
- ADR 02 — Version Hash computation (idempotency key source)
- ADR 03 — OCC Writable CTE (concurrent write conflict, distinct from replay idempotency)
- ADR 09 — LISTEN/NOTIFY Pulse-Fetch pattern (wakeup signal semantics)
- ADR 11 — Worker idempotency and OCC (application-layer complement)
- ADR 28 — `Max_Parallelism` (backpressure ceiling)
- ADR 31 — Frontier Scheduler (produces `pending_dispatch` rows that PgQueueAdapter consumes)
