# ADR 38: Event Status — Execution Lifecycle vs Topological Convergence

**Status:** Accepted  
**Date:** 2026-06-03  
**Supplements:** ADR 19 (Convergence Watchdog), ADR 24 (Gateway infra-write rights)

## Context

`execution_event_log.status` carries two semantically distinct signals that must not be conflated:

1. **Execution lifecycle** — has the Worker thread that processes this event finished? (`terminated`)
2. **Topological convergence** — is this event part of a causal chain that has reached a stable conclusion?

The Convergence Watchdog (INLINE_WATCHDOG_SQL) decides whether to close a Scope by checking:

```sql
NOT EXISTS (
  SELECT 1 FROM execution_event_log
  WHERE scope_id = $1
    AND status NOT IN ('terminated', 'archived')
    AND event_type NOT IN ('scope_closed', 'conflict_detected')
) AS is_converged
```

An event with `status='terminated'` is invisible to this check — the Watchdog treats it as fully resolved.

The `context_oom_throttled` infra-event was originally written with `status='terminated'` on the grounds that the Worker execution thread is physically dead after an OOM. This is correct at the execution level but wrong at the topological level: the Scope is frozen mid-flight, awaiting human intervention to unsuspend. Marking the event `terminated` causes the Watchdog to count the Scope as converged, allowing `scope_closed` to be written against a Scope with an incomplete, OOM-interrupted causal chain. Downstream agents reading this Scope — including nested scopes (ADR 23) via `sub_scope_resolved` — would receive the incorrect signal that the Scope completed cleanly.

## Decision

`context_oom_throttled` events are written with `status='suspended'`, not `status='terminated'`.

The status value `suspended` is formally defined as:

> The associated execution thread is no longer running, **but the event's causal position remains unresolved**. The Topological Convergence Watchdog treats `suspended` events identically to `pending_scheduling` — they block `scope_closed` until either the Scope is explicitly resumed (control plane intervention) or a recovery event supersedes them.

## Status Value Semantics

| `status` | Execution thread | Topological convergence |
|---|---|---|
| `pending_scheduling` | Never started | Unresolved |
| `pending_dispatch` | Queued | Unresolved |
| `processing` | Running | Unresolved |
| `writing` | Running | Unresolved |
| `terminated` | Finished | **Resolved** |
| `archived` | Finished | **Resolved** |
| `suspended` | Dead (OOM) | **Unresolved — blocks convergence** |

Only `terminated` and `archived` satisfy the Watchdog SQL. `suspended` does not.

## Why Not Check `scope_lineage.status` Instead?

An alternative considered was: keep `status='terminated'` and add a `scope_lineage.status = 'suspended'` guard to the Watchdog SQL. This was rejected because:

1. It adds a cross-table join to a hot-path SQL that runs on every `POST /v1/scopes/:id/events` request.
2. The Watchdog should reason about causal graph topology, not about Scope metadata. Whether an event resolves topological convergence is an event-level property.
3. `suspended` adds no complexity to the Frontier Scheduler (`WHERE status = 'pending_scheduling'` — unaffected) or PgQueueAdapter (`WHERE status = 'pending_dispatch'` — unaffected).

## Consequences

### Positive
- A suspended Scope can never accidentally receive `scope_closed` — the Watchdog SQL naturally blocks convergence while any `suspended` event exists in the partition.
- The `scope_lineage.status = 'suspended'` and `execution_event_log.status = 'suspended'` columns are consistent — both signal the same topology-level truth.
- CONTEXT.md's definition of Suspended ("看门狗在检测到未解除的挂起事件时阻断 scope_closed 判定") is now accurate without any documentation change.
- Frontier Scheduler and PgQueueAdapter are unaffected: both query specific status values (`pending_scheduling`, `pending_dispatch`) that exclude `suspended`.

### Negative / Trade-offs
- `suspended` must be documented and understood as a new terminal-but-unresolved status. Developers familiar with only `terminated`/`archived` as terminal states may be confused.
- Any future "resume a suspended Scope" feature must update the event's status away from `suspended` (or insert a recovery event) to allow convergence to proceed. This recovery path is not specified here — deferred to the phase that introduces human-in-the-loop Scope recovery.

## References
- ADR 19 — Convergence Watchdog (Tier 3 SQL — the SQL that this ADR affects)
- ADR 24 — Gateway infra-write rights (context_oom_throttled is an infra-write from the Gateway)
- CONTEXT.md §Context OOM 三级降级链路
- CONTEXT.md §Suspended（挂起）
