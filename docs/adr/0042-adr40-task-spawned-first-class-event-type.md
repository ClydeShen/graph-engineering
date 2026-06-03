# ADR 40: task_spawned as First-Class event_type Column Value

**Status:** Accepted  
**Date:** 2026-06-03  
**Amends:** ADR 11 (OCC Writable CTE)

## Context

The original OCC_WRITE_SQL hardcoded `event_type='memory_updated'` for all external agent writes, storing the submitted semantic type (`task_spawned` or `memory_updated`) in payload JSON only. This was a causal dimensionality collapse: the DB column — the primary index surface — lost semantic resolution, forcing Phase 2 retrievers and ConflictResolverWorker to parse payload text to recover event identity.

Concretely: `WHERE event_type = 'task_spawned'` returns zero rows. BM25+RRF retrieval by event semantics is impossible without `payload::jsonb` casts, which ADR 02 explicitly prohibits (jsonb reorders keys, corrupting hash preimage readability).

## Decision

`OCC_WRITE_SQL` accepts `$5 event_type TEXT`. The agent-submitted type (`task_spawned` or `memory_updated`) is stored directly as the `event_type` column value and included in the version_hash formula:

```
digest(scope_id|entity_id|predecessor_hash|$5_event_type|canonical_json_text, 'sha256')
```

The DO UPDATE (conflict_detected) path finds the winner via `event_type NOT IN ('conflict_detected')` instead of `event_type = 'memory_updated'`, handling both winner types correctly.

`OCC_WRITE_DO_NOTHING_SQL` (Worker result re-delivery) retains hardcoded `memory_updated` — Worker results are always semantic memory updates regardless of triggering event type.

## event_type column semantics (complete)

| value | written by |
|---|---|
| `plan_created` | Control Plane nesting DDL |
| `task_spawned` | External agent (OCC_WRITE_SQL $5='task_spawned') |
| `memory_updated` | External agent (OCC_WRITE_SQL $5='memory_updated') OR Worker result (OCC_WRITE_DO_NOTHING_SQL) |
| `conflict_detected` | OCC DO UPDATE causal inversion (ADR 11) |
| `scope_closed` | Gateway inline Watchdog (ADR 24) |

`task_spawned` is removed from the "allowed by DB constraint but never written" category. All five canonical event types (CONTEXT.md §法定认知事件) now appear in the DB column.

## Consequences

- Phase 2 queries: `WHERE event_type = 'task_spawned'` now returns correct results.
- ConflictResolverWorker can distinguish conflict type from the DB column without payload parsing.
- Hash chain integrity: version_hash for `task_spawned` and `memory_updated` events with identical payloads are now distinct (event_type is in the hash formula).
- `OccWriteArgs.eventType` is a required field — TypeScript enforces caller intent. `occWriteIdempotent` uses `Omit<OccWriteArgs, 'eventType'>` since event_type is always `memory_updated` for that path.

## References
- ADR 02 — hash formula and ::jsonb prohibition  
- ADR 11 — OCC Writable CTE (amended by this ADR)
