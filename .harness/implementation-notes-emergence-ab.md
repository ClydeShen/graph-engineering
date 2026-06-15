# Implementation Notes — Emergence Loop A/B (GH #24)

Worktree: `D:/Repo/graph-eng-emergence-ab` on `exp/emergence-loop-ab` (baseline `ba5d1a1f`).
Gates verified before any code: master clean ✅; LLM live ✅ (`memex doctor` → nvidia reachable + bge-m3 embedding reachable).

## Decisions made (not fully covered by the spec)

### D-1 — Injection toggle seam = single env read in process-agent-turn.ts, not a threaded param
`processAgentTurn` has 5 callers (events route, ws-protocol, conversation/core, terminal-pi, self).
Threading an `injectProcedural` param through all of them is invasive for an experiment knob.
Instead: `MemReflectInput` gains optional `inject_procedural?: boolean` (default true =
production unchanged), and process-agent-turn reads `process.env.MEMEX_INJECT_PROCEDURAL`
at the single memReflect call site. Rationale: the issue itself calls this "a config flag";
a single deployment-config read mirrors how `CONTEXT_W_MAX` is read. The A/B runner controls
the gateway process env per arm. Only the agent write path (process-agent-turn) is toggled —
the chat path (conversation/core) is out of scope for the trap-task experiment.

`MEMEX_INJECT_PROCEDURAL` truthiness: unset/`1`/`true` → ON; `0`/`false` → OFF. Default ON so
all existing tests stay green without setting the env.

### D-2 — Failure terminal state = scope suspension (context-OOM lockout)
The reinforcement loop only credits `success_count+1` on `scope_closed`, which is written
ONLY on convergence (process-agent-turn step 4). Non-converged scopes never emit a closure
event, so `failure_count` had no write point — the monotonic Proxy Signal bug.

The only non-converged terminal transition that exists is **suspension** via
`writeContextOomThrottled` (status→suspended, ADR-39 lockout). That is the symmetric negative
of converged-closure: the scope failed to converge within budget and is shut down. So the
injected templates that were present get `failure_count+1` there.

Idempotency without a schema change: once a scope is suspended, `checkSuspended` short-circuits
at process-agent-turn step 1 on every subsequent turn, so the OOM/suspension branch fires at
most once per scope. No `template_injection.outcome` column needed.

NOT chosen: penalizing on converged-but-deviated closure. The locked design treats the
convergence boolean as the success guardrail — a net-converged scope is a success even with
deviations along the way. Erase/abandon paths are privacy ops, not quality signals, so they
do not feed failure_count.

### D-3 — failure_count is a correctness fix, NOT the A/B dependent variable
The A/B dependent variable is **events-to-convergence** (measured directly by the runner) +
the convergence boolean. failure_count is permanent artifact #2: it makes `trailDiscoveryHitRate`
(`eval-metrics.ts`) falsifiable (non-monotonic), closing the Popperian-falsification violation
flagged in CLAUDE.md §5. It is unit-tested deterministically; it does not gate the live run.
Even if suspension is a coarse failure proxy, it cannot bias the events-to-convergence delta.

## Permanent artifacts (merge to master)
1. procedural injection toggle (`inject_procedural` + env seam)
2. failure_count write path (`penalizeInjectedTemplates` + suspension-branch wiring)

## Scaffolding (kept as regression eval OR deleted — decided at landing)
- trap-task fixture + A/B runner

## ⚠ BLOCKER FINDING (F-1) — convergence has no happy-path terminalizer

While designing the trap-task runner I traced the convergence mechanics end to end
and hit a structural problem that gates the A/B's dependent variable
(events-to-convergence).

Convergence SQL (identical in `watchdog-sql.ts` inline gateway path AND
`control-plane/watchdog.ts` Tier 3):
```
is_converged = NOT EXISTS (row WHERE status NOT IN ('terminated','archived')
                              AND event_type NOT IN ('scope_closed','conflict_detected'))
```

But the status lifecycle of agent-written events is:
- every OCC write defaults `status='pending_scheduling'` (migration 002:60; occWrite
  never sets status, the CTE omits the column)
- `claim_next_task` sets the task_spawned row → `'processing'` (core.ts:36)
- `complete_task` writes a NEW memory_updated row → default `'pending_scheduling'`

Exhaustive grep for terminal-status transitions on execution_event_log across all
packages finds only THREE writers of `status='terminated'/'archived'`:
1. `frontier.worker.ts:155` — terminates **cycle-detected** tasks only (error path)
2. the `scope_closed` INSERT itself (the closure event row, not the task rows)
3. `handleContextOom` → `'suspended'` (the failure path artifact #2 hooks)

⟹ There is **no happy-path step that terminalizes a completed task**. A scope that
spawns any subtask leaves a `processing` task_spawned row + a `pending_scheduling`
memory_updated row, both non-terminal and non-(closed/conflict). So
`is_converged` stays FALSE forever and the watchdog never emits `scope_closed`.

Consequence for #24: the success side of the emergence loop
(`scope_closed → TemplateProposalWorker → reinforceTemplate → success_count+1`)
may **never fire in normal multi-task operation** — a deeper instance of the same
Proxy-Signal class as the failure_count gap. No test in the repo drives a scope to
convergence end-to-end (all either mock `checkConvergence` or stop at complete_task),
which is consistent with this.

Confidence: HIGH — now LIVE-VERIFIED. `scripts/eval/ab-convergence-probe.ts`
(in-process gateway buildApp vs graph_test) drove a scope through
plan_created → spawn → claim → complete and queried the convergence SQL at each
step. Result:
```
[after plan_created (no subtasks)]  is_converged=false  plan_created=pending_scheduling
[after spawn_subtask]               is_converged=false  +task_spawned=pending_scheduling
[after claim_next_task]             is_converged=false   task_spawned=processing
[after complete_task]               is_converged=false   +memory_updated=pending_scheduling
```
Even an EMPTY scope (plan_created only) never converges — plan_created itself
stays `pending_scheduling`. No happy-path event reaches a terminal status, so the
convergence SQL is unsatisfiable for any scope created via the standard
gateway + MCP path. The success side of the emergence loop does not fire here.

Implication: the A/B "events-to-convergence" dependent variable cannot be
instrumented faithfully until either (a) the missing terminalizer is found, or (b)
this is confirmed as a real architectural gap and a happy-path task-termination
step is added. The two permanent artifacts are unaffected and stand on their own.

## Open / deferred
- Whether the trap fixture stays on the board as a regression (issue HITL note) — decide at step 6.
- F-1 must be resolved before the live A/B (task #4) can run.
