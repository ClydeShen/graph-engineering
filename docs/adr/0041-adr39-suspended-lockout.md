# ADR 39: Suspended Lockout — Gateway Rejects Writes to Suspended Scopes

**Status:** Accepted  
**Date:** 2026-06-03  
**Supplements:** ADR 38 (Event Status Semantics), ADR 24 (Gateway infra-write rights)

## Context

ADR 38 establishes that `context_oom_throttled` events are written with `status='suspended'`, which blocks the Convergence Watchdog from closing an OOM-interrupted Scope. However, blocking convergence alone is insufficient: the Gateway still accepted new event submissions from external agents for suspended Scopes.

This created an infinite OOM loop:

```
Scope hits OOM → context_oom_throttled written (status='suspended')
→ external agent POST /v1/scopes/:id/events (unaware of suspension)
→ new event written (status='pending_scheduling')
→ Frontier Scheduler picks it up → Worker triggers → assembleContext hits OOM again
→ another context_oom_throttled → loop
```

Each iteration burns a Worker slot, adds a new suspended event to the partition, and leaves the Scope in increasingly corrupt topological state without any error observable to the external agent.

## Decision

The Gateway enforces a **Suspended Lockout** on `POST /v1/scopes/:id/events`: if `scope_lineage.status = 'suspended'`, the request is rejected immediately with `409 Conflict` before any OCC write attempt.

Response body:
```json
{ "error": "scope suspended", "scope_status": "suspended" }
```

The lockout is absolute for all non-privileged requests. There is no "recovery event" path through this endpoint. Scope recovery is a Control Plane operation (future phase), not an agent-initiated operation.

## What "Non-Privileged" Means

The Gateway holds two infra-write rights (ADR 24):
- `scope_closed` — written via `writeScopeClosed()` (direct `pool.query()`)
- `context_oom_throttled` — written via `writeContextOomThrottled()` (direct `pool.query()`)

Both are direct database calls that never pass through `POST /v1/scopes/:id/events`. They are inherently privileged and bypass the lockout. No special bypass token or header is required.

External agents submit events exclusively through `POST /v1/scopes/:id/events`. This endpoint is exclusively non-privileged. The lockout therefore applies to 100% of the traffic on this endpoint.

## Implementation

Check inserted as Step 1b in `buildEventsRoute()`, after Zod/UUID validation (Step 1) and before OCC write (Step 2):

```typescript
const scopeRow = await pool.query<{ status: string }>(
  'SELECT status FROM scope_lineage WHERE scope_id = $1',
  [id],
);
if (scopeRow.rows[0]?.status === 'suspended') {
  logger.child({ component: 'gateway', scope_id: id }).warn(
    LOG_EVENTS.SCOPE_SUSPENDED_LOCKOUT,
  );
  return c.json({ error: 'scope suspended', scope_status: 'suspended' }, 409);
}
```

A `scope.suspended.lockout` warn-level pino log fires on every rejected request, allowing ops to observe the suspension without an ERROR flood.

## Why 409 and Not 423 (Locked)

HTTP 423 Locked is a WebDAV extension. 409 Conflict is standard HTTP and semantically accurate: the request conflicts with the current resource state. External agents built against standard HTTP clients handle 409 uniformly.

## Why Not Allow Recovery Events Through This Endpoint

Allowing "special" recovery events through the same endpoint as normal events creates ambiguity about what triggers recovery. Scope recovery is an infrastructure operation with access to privileged write channels — it should be a future Control Plane API, not a signal embedded in agent payloads. Keeping the lockout absolute preserves the clean separation between agent-visible and infrastructure-visible surfaces.

## Consequences

### Positive
- The OOM infinite loop is structurally impossible: the Gateway breaks the cycle at the entry point.
- External agents receive a deterministic, observable 409 error instead of silently accumulating OOM events.
- `scope.suspended.lockout` warn logs give ops a monitoring hook without ERROR noise.
- The check adds one indexed point-lookup (`scope_lineage` PRIMARY KEY on `scope_id`) per event request — negligible overhead on the hot path.

### Negative / Trade-offs
- All Gateway integration tests that POST events must set up `scope_lineage` rows correctly (status != 'suspended') or they will receive 409.
- No self-service Scope recovery path for external agents. This is intentional but may require documentation for agent developers who encounter 409 unexpectedly.
- The lockout check adds one extra DB round-trip per event POST. For Phase 1 single-node deployments this is fine; Phase 3+ distributed deployments may want to cache `scope_lineage.status` in Redis.

## References
- ADR 38 — Event status semantics (establishes 'suspended' as a convergence-blocking status)
- ADR 24 — Gateway infra-write rights (defines privileged vs non-privileged write surfaces)
- ADR 19 — Convergence Watchdog (the SQL that 'suspended' status naturally blocks)
