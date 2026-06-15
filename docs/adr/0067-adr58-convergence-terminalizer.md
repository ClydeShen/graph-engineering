# ADR-58 — Convergence terminalizer (happy-path task termination)

- **Status**: Accepted (implemented + tested; GH #29)
- **Date**: 2026-06-16
- **Context source**: live-verified finding F-1 (see `.harness/implementation-notes-emergence-ab.md`)

## Problem

Scopes driven through the standard gateway + MCP path **never converge**. The
convergence SQL (identical in `watchdog-sql.ts` inline gateway path and
`control-plane/watchdog.ts` Tier 3) requires every event row to be terminal:

```sql
is_converged = NOT EXISTS (
  SELECT 1 FROM execution_event_log
  WHERE scope_id = $1
    AND status NOT IN ('terminated','archived')
    AND event_type NOT IN ('scope_closed','conflict_detected'))
```

But no happy-path step terminalizes a completed task:
- every OCC write defaults `status='pending_scheduling'` (migration 002:60)
- `claim_next_task` sets the task_spawned row → `processing` (core.ts:36)
- `complete_task` writes a NEW `memory_updated` (default `pending_scheduling`) and
  never updates the task_spawned row
- the only terminal-status writers are frontier cycle-termination (error path),
  the `scope_closed` row itself, and OOM `suspended`

Live-verified (`scripts/eval/emergence-ab/` probe): `is_converged=false` at every
step, even for an empty plan_created-only scope. Consequence: the emergence loop's
success side (`scope_closed → TemplateProposalWorker → reinforceTemplate →
success_count+1`) **never fires in normal operation**.

## Key constraint discovered — chat scopes must NOT auto-converge

The conversation core (ADR-54) records turns as **`memory_updated` events only —
never `task_spawned`** (core.ts:10). A naive fix that converges any scope with "no
pending work" would close a conversation after its first turn (and crystallize it).
So the current never-converges behavior is **load-bearing for chat scopes**.
Convergence is a **task-scope** semantic, not a conversation semantic.

## Decision

Convergence means **"every task this scope spawned is done"** — and a scope that
never spawned a task (a pure conversation) does not converge.

1. **Convergence predicate** (both watchdog paths, kept identical) becomes:
   ```sql
   is_converged =
        EXISTS (SELECT 1 FROM execution_event_log
                WHERE scope_id=$1 AND event_type='task_spawned')
    AND NOT EXISTS (SELECT 1 FROM execution_event_log
                WHERE scope_id=$1 AND event_type='task_spawned'
                  AND status NOT IN ('terminated','archived'))
   ```
   i.e. ≥1 task_spawned AND no non-terminal task_spawned. (`no_open_conflicts`
   unchanged.) This matches the watchdog's own documented intent ("pending_tasks=0")
   and the Tier-1 `pendingTasks` counter, which already tracks task_spawned only.

2. **Terminalizer**: `complete_task` (core.ts), after writing the completion
   `memory_updated`, sets the task_spawned row terminal:
   ```sql
   UPDATE execution_event_log SET status='terminated'
   WHERE scope_id=$1 AND entity_id=$2 AND event_type='task_spawned'
   ```
   Status is mutable metadata (not in the version_hash) — the same append-only-safe
   UPDATE pattern already used by claim (`→processing`) and frontier cycle-kill
   (`→terminated`). Worker result writes that complete a task via `occWriteIdempotent`
   need the same terminalization at their completion site (audit during impl).

`plan_created` and `memory_updated` are left untouched (they no longer affect
convergence), so there is **zero blast radius** on:
- `knapsack-graph.ts:70` sibling selection (still keys on pending_scheduling)
- `occWrite` / the OCC CTE (unchanged)
- `nesting.ts` plan_created insert (unchanged)
- chat scopes (no task_spawned → never converge → conversations stay open)

## Alternatives considered

- **A — write plan_created/memory_updated terminal (records).** Requires changing
  the OCC CTE + nesting insert, and alters `knapsack-graph` sibling selection and
  metrics. Larger blast radius; still needs the chat-scope guard. Rejected.
- **B — converge on "no pending task" without the EXISTS guard.** Closes chat
  scopes after turn 1 (they have no task_spawned). Rejected — breaks ADR-54.

## Consequences

- Task scopes converge when their tasks finish → `scope_closed` fires →
  crystallization + reinforcement (`success_count+1`) finally runs → the
  `failure_count` path (already merged) and `success_count` path are both live →
  `trailDiscoveryHitRate` becomes a real, non-degenerate signal.
- The faithful GH #24 A/B becomes runnable on the real path (no harness shims).
- An empty scope that DID spawn a task but it was never completed stays open
  (correct — pending work).

## Implementation plan

1. Update both convergence SQL sites (watchdog-sql.ts, watchdog.ts) — keep identical.
2. Add the task_spawned terminalize to `complete_task`; audit `occWriteIdempotent`
   worker-completion sites for the same.
3. Tests: a DB-backed test that spawn→claim→complete drives `is_converged=true` and
   emits `scope_closed`; a chat-style scope (memory_updated only) stays unconverged.
4. Re-run `scripts/eval/emergence-ab/ab-convergence-probe.ts` → expect converged.
5. THEN the faithful #24 A/B (drop the harness terminalizer shim).
