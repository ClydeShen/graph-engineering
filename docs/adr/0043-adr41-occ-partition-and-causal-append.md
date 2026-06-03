# ADR 41: OCC Partition-Direct INSERT + Causal Append on Conflict

**Status:** Accepted  
**Date:** 2026-06-03  
**Amends:** ADR 11 (OCC Writable CTE), supersedes ADR 40's conflict-handling description

## Context

Two bugs discovered during Gate 1 testing:

### Bug 1 — Parent table has no unique constraint (G1-Fix-1)

The original `OCC_WRITE_SQL` and `OCC_WRITE_DO_NOTHING_SQL` were static string constants that INSERTed into the parent table `execution_event_log`. PostgreSQL `ON CONFLICT (column_list)` requires the named unique constraint to exist on the table being INSERTed into. The constraint `uk_scope_composite_occ_{id} UNIQUE (predecessor_hash, scope_id)` is defined on each partition (`execution_event_log_scope_*`), not on the parent table.

Result: `ERROR 42P10 no unique constraint matching ON CONFLICT specification` on every agent write.

### Bug 2 — DO UPDATE mutated the winner row (G1-Obs-2)

The original conflict handling:

```sql
ON CONFLICT (predecessor_hash, scope_id)
DO UPDATE SET
  event_type    = 'conflict_detected',
  version_hash  = encode(digest(...), 'hex'),
  payload       = EXCLUDED.payload
```

This mutated the winner row in-place — the row that `task_spawned` or `memory_updated` was written into was overwritten with `event_type='conflict_detected'`. Two invariants were violated:

1. **Append-only violated**: An existing, committed graph node changed meaning. The row that was `task_spawned` at position P became `conflict_detected` at the same position. Readers traversing the causal chain now see `conflict_detected` at a structural position that should hold the winner event.

2. **ConflictResolverWorker context destroyed**: The conflict event cannot reference the winner if it overwrote the winner. The resolver has no signal about which agent won, only that a conflict was recorded at position P.

ADR 40's description of "DO UPDATE (conflict_detected) path finds winner via `event_type NOT IN ('conflict_detected')`" describes a system state that is self-inconsistent: a DO UPDATE that sets `event_type='conflict_detected'` then cannot be found by a filter that excludes `conflict_detected`.

## Decision

### Fix 1 — Direct partition INSERT

`OCC_WRITE_SQL` and `OCC_WRITE_DO_NOTHING_SQL` are changed from static string constants to functions accepting a `partition: string` parameter:

```typescript
export function OCC_WRITE_SQL(partition: string): string { return `
  INSERT INTO ${partition} (...)
  ...
`; }
```

Callers use `partitionTable(scopeId)` to compute the target before calling:

```typescript
export function partitionTable(scopeId: string): string {
  return `execution_event_log_scope_${scopeId.replace(/-/g, '')}`;
}
```

### Fix 2 — Causal append, not causal inversion

Conflict handling is split into four CTEs:

```
attempt        — INSERT with DO NOTHING; winner row is never mutated
winner         — SELECT the row that holds predecessor_hash (excluding conflict_detected)
conflict       — INSERT a NEW conflict_detected row whose predecessor = winner.version_hash
demoted_fallback — handle two concurrent losers racing for the conflict slot
```

The winner row is immutable after initial insert. The conflict event is a new node appended after the winner in the causal chain, not a rewrite of the winner.

```
predecessor_hash P
      │
      ▼
 [winner: task_spawned]   ← never mutated
      │
      ▼
 [conflict_detected]      ← NEW row, predecessor = winner.version_hash
```

## Consequences

- Winner rows are immutable after commit. Append-only invariant is fully preserved at the OCC level.
- ConflictResolverWorker receives a genuine causal reference: it can read the `conflict_detected` row's `predecessor_hash` to find the winner, and compare payloads to determine which agent's intent should prevail.
- `occ_result='demoted'` is returned for any loser, including the edge case where two losers race for the `conflict_detected` slot (handled by `demoted_fallback` CTE).
- ADR 40's conflict-handling description ("DO UPDATE path") is superseded. The event_type column semantics table in ADR 40 remains correct.

## References

- ADR 02 — append-only invariant
- ADR 04 — per-scope partition DDL and unique constraint
- ADR 11 — OCC Writable CTE (amended by ADR 40 and this ADR)
- ADR 40 — task_spawned as first-class event_type (conflict resolution description superseded)
- `packages/shared/src/sql/occ-writable-cte.sql.ts` — implementation
