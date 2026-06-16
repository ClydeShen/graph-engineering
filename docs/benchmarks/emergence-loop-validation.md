# Loop Engineering: a causal benchmark of self-improvement in the Memex agent runtime

> Status: living benchmark document. Numbers come from `scripts/eval/faithful-ab/`
> run against a live LLM and are committed with the raw JSON in
> `.harness/analysis/faithful-ab/`. Re-runnable; see Section 8.

## Abstract

Memex is a graph-native agent runtime whose central bet is that reusable procedures
should not be authored but should emerge: a successful run is distilled into a
procedural template, recalled on similar later tasks, and reinforced when it helps.
We call the practice of building, measuring, and repairing that feedback loop Loop
Engineering, and this document is a Loop Engineering case study. The question is
empirical and falsifiable: does the loop actually make the runtime reach a goal in
fewer steps as it accumulates experience?

We test it causally rather than anecdotally. On an 11-step "stand up a microservice"
task with a real dependency DAG and two non-obvious ordering quirks, we measure
events-to-convergence (the number of immutable ledger events a live LLM agent emits
before the task completes) under two designs: a controlled A/B that toggles template
injection on or off, and a learning curve that runs the full loop across repeated
cold-start runs.

Injection works. A recalled runbook removes the non-obvious-quirk failures an
uninjected agent hits in 75% of runs: ON 24.0 ± 0.0 events with 0 gate failures, OFF
25.5 ± 0.9 with 0.8, a 6% reduction bounded by how much of the DAG a capable model
already infers. The autonomous learning curve was initially flat, and the diagnosis
is the contribution. The loop converged, crystallized, and recalled, but
crystallization replayed the executed path including the cold run's mistake. It
distilled "run_tests, containerize, run_tests (retry)" verbatim, so the agent
reproduced its first flawed trajectory on every later run. The fix is to crystallize
the corrected order that avoids the observed mistakes rather than the path taken. The
curve then declines: the agent makes the non-obvious mistake once (run 1, 26 events)
and is optimal thereafter (runs 2-10, 24 events, zero gate failures). Scaled to 18
steps with six counter-intuitive quirks the effect grows to 12% and learning still
emerges, though it becomes gradual and plateaus one quirk short of optimal. Template
consolidation can reach the optimum but is variance-fragile on a non-deterministic
model: the consolidation step is a closed feedback loop that bimodally either holds the
optimum or collapses, and making it robust is open work (Section 5.7). A second,
naturally-occurring precondition (a skill whose backing CLI must be installed before
use) is learned robustly, because a shallow task cannot lock in a bad template. A
methodological corollary: effect size tracks genuinely hidden structure, not task
size. Quirks that match a strong model's training priors produce no effect and
nothing to learn. The work also fixed two latent defects, an unfalsifiable success
metric and a missing convergence terminalizer, that had prevented the loop's success
path from firing at all. That fix is the precondition that made the measurement
possible.

## 1. Introduction

A runtime that claims to "improve with use" is making an empirical statement about a
learning curve, not advertising a feature. The statement can be true or false, and a
system that cannot measure it cannot be trusted to have it. Loop Engineering is the
discipline that takes the claim seriously: build the feedback loop, instrument it,
and verify on data that experience actually lowers cost. This document builds that
instrument for Memex and reports what it shows.

We separate three causal links so that a null result points at a specific stage
rather than the system as a whole:

- L1, injection to efficiency: does recalling a relevant procedural template make an
  agent reach the goal in fewer steps?
- L2, crystallization to template: does a converged run produce a template that
  captures reusable structure?
- L3, the lifecycle: does the runtime actually converge and fire the loop under
  normal operation?

The A/B (Section 4) isolates L1. The learning curve (Section 5) exercises L1, L2, and
L3 together and is the direct test of the loop.

## 2. The Memex runtime and the emergence loop

This section gives a reader with no prior context enough of the architecture to
follow the experiments.

### 2.1 A graph-native runtime

Most agent frameworks treat the LLM context window as mutable state: the agent reads
and overwrites a buffer as it works. Memex inverts that. Every agent action is
recorded as an immutable, content-addressed event in an append-only ledger (the
execution graph, internally the Trail Mesh). Nothing is overwritten. The context for
any single step is projected from the graph on demand, so the graph is the source of
truth and the context window is a derived view. The name and the design come from
Vannevar Bush's 1945 proposal: he described a hypothetical device, the Memex, that
would extend human memory through associative trails rather than hierarchical
indexes. This runtime makes those trails computable for agents.

A unit of work is a scope: a task together with the sub-tasks it spawns. Agents write
a small fixed set of event types, the ones that matter here being `task_spawned`
(open a unit of work), `memory_updated` (record a result), `scope_closed` (the scope
is finished), and `conflict_detected` (two writes raced). A scope converges when all
the work it spawned is done; the runtime then writes `scope_closed`. Convergence is a
task-completion signal, not a conversation signal, which matters in Section 3.

### 2.2 No authored workflows; procedures emerge

Memex has no workflow engine: no DAG authoring, no pipeline definitions. Reusable
procedures are not designed, they emerge as statistical regularities across past
runs. The mechanism, internally "trail discovery" (Phase 10), is a closed loop:

- Crystallize: when a scope converges, a `TemplateProposalWorker` distills its event
  DAG into a procedural template (a Lesson) capturing the structure that worked.
- Recall and inject: on a later cold start, `mem::reflect` retrieves templates by
  hybrid (vector + BM25) similarity and injects them into the agent's context.
- Reinforce and decay: a template that helps a scope converge is reinforced
  (`success_count + 1`); templates that go unused are superseded on an Ebbinghaus
  decay schedule.

This loop is the runtime's central bet: that an agent which records its trails and
crystallizes them will get cheaper at recurring work without anyone authoring a
workflow. Whether the bet pays off is exactly the empirical question this benchmark
answers.

### 2.3 Two defects that had disabled the loop

Building the benchmark surfaced two latent defects. Together they meant the success
side of the loop never fired in normal operation.

- D1, unfalsifiable success metric. `trailDiscoveryHitRate = Σ success_count /
  Σ injection_count`, but nothing ever incremented `failure_count`. The metric was
  monotonic: it could only rise, never detect the loop getting worse (a Proxy-Signal
  anti-pattern). Fixed by a `failure_count` write path on non-converged terminal
  states (merged `11ef17e5`).
- D2, no convergence terminalizer (finding F-1). The convergence check required every
  event row to be terminal, but no happy-path step terminalized a completed task, so
  scopes driven through the standard gateway and MCP path never converged and
  `scope_closed` (which triggers crystallization and reinforcement) never fired. A
  probe confirmed it live: `is_converged=false` at every step, even for an empty
  scope. Fixed by ADR-58 (merged `9ebd175a`): converge on "every spawned task is
  done", with an `EXISTS(task_spawned)` guard so pure-conversation scopes (which
  record only `memory_updated`) are never auto-closed, and `complete_task`
  terminalizes the task row.

Until D2 was fixed, any learning-curve measurement was trivially flat: no
convergence, so no crystallization, so no learning. The benchmark is only meaningful
on a runtime where D2 is fixed, which is the contribution that made the measurement
possible.

## 3. Apparatus: a long task with hidden structure

Task: "stand up a new microservice", 11 steps over a real dependency DAG.

```
scaffold -> add_deps -> write_api -> containerize ----------------------+
        \-> db_schema -> gen_migrations --+                             +-> deploy
start_db -------------------------------- +-> run_migrations -> run_tests +
write_api -> write_tests -----------------------------------------------+
```

Most edges are intuitive (scaffold first, deploy last). Two are non-obvious quirks an
agent cannot infer from names and that only a learned runbook carries:

- Q1: `run_tests` requires `containerize` first (tests run inside the container).
- Q2: `gen_migrations` requires `add_deps` first (the migration tool is a project
  dependency).

The goal text lists the steps alphabetically and never reveals the dependency graph.
An agent that respects only the intuitive dependencies trips Q1 or Q2, which produces
a gate failure and rework. The injected runbook encodes the full topological order
including the quirks.

Dependent variable: events-to-convergence, the count of immutable ledger events in
the scope when `scope_closed` is written. Each step is one real MCP round trip
(`spawn_subtask`, `claim_next_task`, `complete_task`), about 2 events; a gate failure
adds a failed attempt, about 2 wasted events. Guardrails: the convergence boolean
(real `checkConvergence`) and goal achievement (all 11 steps completed).

Faithfulness: the agent drives the task through the real MCP tools, so
`complete_task`'s ADR-58 terminalizer fires and convergence is the runtime's own
decision, with no measurement shim. The only harness-side action is triggering the
`scope_closed` write that the control-plane watchdog performs in production; the
convergence decision (`checkConvergence`) is the real one. The dependency gate is the
task's environment, not a measurement artifact.

Model and controls: live `openai/gpt-oss-120b`, temperature 0. Task text, golden
template seed, `w_max`, and gate are identical across arms. The only manipulated
variable is procedural injection (`MEMEX_INJECT_PROCEDURAL`, threaded as
`inject_procedural`). Recall degrades to BM25 when the embedding endpoint is
unavailable (ADR-55); the injection mechanism is unchanged and only the recall route
differs.

## 4. Experiment A. A/B: injection to efficiency (L1)

The golden runbook is direct-seeded, which isolates L1 from L2. The same task runs
N=8 times per arm with injection on or off; we compare events-to-convergence.
`openai/gpt-oss-120b`, temperature 0, BM25 recall.

| arm | events-to-convergence | gate failures / run | recall | converged | goal |
|---|---|---|---|---|---|
| ON  | 24.0 ± 0.0 (all 8 = 24) | 0.0 | 100% | 8/8 | 8/8 |
| OFF | 25.5 ± 0.9 [24-26] | 0.8 (6/8 tripped a quirk) | - | 8/8 | 8/8 |

Injection reduces events by 6% (24.0 vs 25.5). The signal is in the mechanism and its
reproducibility, not the headline percentage. The ON arm is deterministic: 24 events
and zero gate failures across all 8 runs, because the recalled runbook makes the agent
respect the non-obvious quirks every time. The OFF arm trips a quirk in 6 of 8 runs
(the other 2 ordered correctly by chance), each paying one failed attempt, about 2
wasted events. Injection removes a failure the uninjected agent hits in 75% of runs.
The magnitude is small because a capable model infers the rest of the 11-step DAG
unaided; the effect equals the hidden, non-inferable structure the template supplies,
here two quirks. That is the L1 result: recall produces fewer events, deterministically,
concentrated on what the agent could not have known.

## 5. Experiment B. Learning curve (L1+L2+L3)

Cold start, with `procedural_memory` wiped. The task runs N=10 times with the full
loop: injection on, and after each converged run the `TemplateProposalWorker`
crystallizes the run into a template the next run can recall. We measure whether
events-to-convergence trends down across runs. `openai/gpt-oss-120b`, temperature 0,
functional embedding (hybrid recall).

### 5.1 Baseline (loop as shipped): the curve is flat

| run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| events | 26 | 24 | 26 | 26 | 26 | 26 | 26 | 26 | 26 | 26 |
| gate failures | 1 | 0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |

First-third mean 25.3, last-third mean 26.0: no learning. Run 2's 24 is the same 25%
lucky-ordering hit seen in the A/B OFF arm, not a learned gain. The agent trips the
same quirk on run 10 as on run 1.

### 5.2 Diagnosis: the loop runs, but crystallization records the wrong thing

Every run converges (after the D2 fix), a template is crystallized (count grows 1 to
10), and recall fires; a probe confirms `mem::reflect` returns templates for the goal
query. L3 and recall work. The defect is in what crystallization produces, in two
layers.

1. Generic content. The crystallized intent was a "what happened" summary ("Create a
   microservice with scaffolding, dependencies, ... containerization, deployment")
   over an anonymized topology skeleton (`{"from":"n0","to":"n13"}`). It neither
   states nor encodes the actionable constraint. We added a `lesson` field to the
   crystallization prompt asking for the ordering and dependency. Recall then carried
   quirk-relevant text, but the curve stayed flat, which exposed the deeper layer.
2. It replays the executed path, including the mistake. The cold run made the quirk
   error (run_tests before containerize, failed, retried). The lesson the model
   distilled encoded that exact sequence, verbatim, from a crystallized template:
   "...run_tests (initial), containerize, run_tests (retry)...". Following that lesson
   reproduces the mistake. The loop was reinforcing its first flawed trajectory, not
   the optimal one. This is the precise reason no improvement emerged: the system
   learned the path it took, not the path it should have taken.

### 5.3 The fix (commit `08c2af7f`)

Crystallization now distills the corrected, optimal order that avoids the observed
mistakes: each non-obvious dependency phrased as a rule ("X must be done before Y"),
each step listed once, the failed-then-retried detour dropped. The anonymized
`template_graph` still serves topological recall; the readable lesson is what the
agent reads. The change is two lines of prompt plus a content enrichment. The
`lesson` field is optional, so any scope without a reusable order is unchanged.

### 5.4 After the fix: the curve declines

| run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| events | 26 | 24 | 24 | 24 | 24 | 24 | 24 | 24 | 24 | 24 |
| gate failures | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

The agent makes the non-obvious mistake exactly once (run 1, cold), crystallizes the
corrected order, and is optimal on every run thereafter (24 events, zero gate
failures, runs 2-10). The curve is a clean step function at temperature 0: first-third
mean 24.7, last-third mean 24.0. The runtime measurably got cheaper with use, and by
construction it did so on the one constraint it could not have known a priori. The
loop delivers what Loop Engineering targets once crystallization distills the corrected
structure rather than replaying the executed trajectory.

### 5.5 Scaled validation: 18 steps, 6 quirks, and what "hidden" means

To test robustness we scaled the task to 18 steps with six non-obvious prerequisites
(a microservice with CI/CD and observability). The first attempt produced a sharp
methodological finding.

Quirks that match standard practice are not hidden to a strong model. The first six
quirks were realistic but conventional CI/CD rules (lint before build, scan the image,
test in container). The model inferred all of them from training: the OFF arm hit zero
gate failures (38 events, the same as ON). There was nothing to learn because there
was no structure the model did not already have. Effect size is a function of
genuinely hidden structure, not task size.

We redesigned the six quirks to reverse intuition, as project-specific rules a model's
priors actively mislead it on: `db_schema` after `write_api` (schema derived from the
API), `lint` after `write_tests`, `security_scan` before the build, `run_migrations`
after `run_tests`, `setup_monitoring` after `deploy`. The model's natural CI/CD order
now violates them.

A/B, 8 reps per arm, with the counter-intuitive quirks:

| arm | events | gate failures / run | recall |
|---|---|---|---|
| ON  | 38.3 ± 0.7 [38-40] | 0.1 | 100% |
| OFF | 43.5 ± 3.4 [38-48] | 2.8 | - |

The effect is 12%, double the 11-step DAG's 6%, which confirms the effect grows with
hidden structure. ON is near-perfect (one of eight runs slipped a single failure).
OFF averages 2.8 gate failures with high variance: some runs trip 5 of the 6 reversed
rules, one ordered correctly at 0. The model still infers part of the order, so the
effect equals the truly counter-intuitive subset.

Learning curve, 10 runs, full loop:

| run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| events | 46 | 46 | 48 | 42 | 40 | 40 | 40 | 42 | 40 | 40 |
| gate failures | 4 | 4 | 5 | 2 | 1 | 1 | 1 | 2 | 1 | 1 |

First-third mean 46.7, last-third mean 40.7: a 13% improvement, larger than the
11-step DAG's, as expected from more genuinely hidden structure. Gate failures fall
from 4 to 5 (cold) to a steady 1. The loop scales, but learning here is gradual and
partial, not the clean step function of Section 5.4.

- It does not reach the injected optimum (38 events, 0 failures). It plateaus near 40
  with one residual gate failure. The system learns most of the six reversed rules,
  not all of them.
- The descent spans several runs (notably runs 1 to 4) rather than snapping after one,
  because crystallizing a clean corrected order over six reversed constraints, with
  recall mixing an accumulating set of partial templates, is a harder distillation
  than the single-quirk case.

This is the honest scaled result at this stage. The loop scales and the magnitude grows
with hidden structure (13%, above the small-DAG effect), but at higher complexity the
autonomous loop captures most of the hidden structure, not all. The plateau has a
specific cause, the accumulating partial templates, and Section 5.6 removes it.

### 5.6 Consolidation: removing the plateau

Section 5.5 plateaus because recall injects a mixture of partial runbooks. Each
converged run crystallizes a template that captures most, not all, of the six reversed
rules, and the templates accumulate. The fix is to consolidate them into one canonical
runbook at crystallization time. When a scope closes, the worker looks up the prior
canonical template for the same task, folds the new run's corrected lesson into it as a
superset of the ordering rules, writes the merged canonical, and supersedes the prior.
Recall filters superseded rows, so injection draws on exactly one runbook.

The merge key is the decision that matters. The first implementation matched the prior
template by the cosine similarity of its intent embedding, the vector of an LLM-written
summary of the scope. It failed: the summary wording drifts from run to run, so the
embedding fell below the match threshold about two thirds of the time, the lookup
missed, and a fresh canonical was written instead of superseding the old one. The
learning curve reached the optimum for runs 2 to 5 (38 events, 0 gate failures, which
the mixture never achieved) and then regressed to 44 and 46 as the unmatched templates
re-formed the mixture. A direct database count confirmed the cause: seven live canonical
rows against three superseded, out of nine possible consolidations.

The fix is to key the merge on the converged graph topology rather than the prose
summary. The Weisfeiler-Lehman topology embedding is computed deterministically from the
event DAG, so two runs of the same task that converge on the same dependency structure
produce the identical vector and match reliably, while a run with extra rework events
produces a different graph and cannot silently overwrite the clean canonical. The
canonicalization abstracts the executed rework away, so every converged run of the task,
regardless of how many gate failures it incurred, consolidates into the same canonical.

Re-running the 18-step curve with topology-keyed consolidation:

| run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| events | 42 | 42 | 46 | 40 | 40 | 40 | 38 | 38 | 38 | 38 |
| gate failures | 2 | 2 | 4 | 1 | 1 | 1 | 0 | 0 | 0 | 0 |

In this run the curve descends to the injected optimum: the final four runs are 38
events with zero gate failures, and a database count shows one live canonical against
nine superseded, the consolidation firing on all nine repeats. We first read this as the
plateau being removed. **Section 5.7 shows that reading was premature: this 38/0 result is
one good draw, not a robust property.** It is reported here as the observation that
motivated the deeper investigation, not as a settled claim.

One implementation detail generalizes the Section 5.4 lesson and does hold. Recall had
never filtered superseded procedural templates, so superseding a row did not withhold it
from injection until that filter was added; the same gap had been silently disabling
Ebbinghaus decay for positive templates. Consolidation only works once supersession
actually removes the old runbook from recall.

### 5.7 Reproducibility: consolidation is variance-fragile, and a robust counter-case

The Section 5.6 result did not reproduce. Re-running the same curve on byte-identical code
produced collapses to the turn cap (121 events, no convergence) instead of 38/0. Treating
this as a regression hunt rather than accepting the first good number is the contribution
of this section.

Two confounds were ruled out by investigation. First, the harness wiped only the
procedural tier at cold start, so episodic and semantic memories accumulated across runs
and polluted recall; making the cold start wipe every memory tier removed that, but the
collapse persisted. Second, the model is a hosted endpoint, not a local server that could
degrade under load. A direct probe settled the actual cause: the hosted model is
**non-deterministic at temperature 0** (three identical crystallization calls returned
three different outputs). On a non-deterministic substrate, any single curve is a draw.

The structural diagnosis is that consolidation is a **closed feedback loop**: the canonical
template is updated from runs that the canonical itself guided. Two natural designs both
fail on a deep task:

- **LLM prose-merge** (Section 5.6): each run folds its lesson into the prior canonical via
  an LLM call. That is prose-into-prose feedback; on a non-deterministic model it drifts,
  and the drift compounds. Outcomes are bimodal: a clean draw holds 38/0, a drifting draw
  corrupts the runbook (an invented step, a reordered rule) and the corrupted runbook then
  misleads the agent into collapse. A database dump of a collapsed run shows exactly this:
  a hallucinated `verify_completion` step that compounded across merges until it buried the
  real ordering rule.
- **No merge** (single-shot canonical per topology): removes the drift, but a single-shot
  lesson is incomplete (Section 5.5), and replacing the canonical with each run's lesson
  lets one bad single-shot lock in a canonical so misleading that later runs never converge
  to update it, producing a *permanent* collapse.

Merge drifts; no-merge collapses. This is a genuine open problem, not a solved one, and the
committed implementation keeps the merge variant as the more recoverable of the two while
this section documents its ceiling honestly.

A simpler task does not exhibit the instability. We added a second, naturally-occurring
precondition: a skill whose backing CLI must be installed before use, enforced by a real
"command not found" rather than a synthetic gate (the shape of the real `agent-browser`
skill, whose SKILL.md is a discovery stub deferring to a binary that must be installed
first). Cold, the agent runs the tool, fails, installs, retries, converges; the loop
crystallizes "install before use"; later runs install first and skip the discovery failure.
Across ten hermetic runs the discovery failure appears once (the cold run) and then stays
at zero. This is robust because the task is recoverable in one or two turns, so a
less-than-perfect template cannot lock in a non-converging trajectory. The same property
that makes the 18-step task fragile (a deep task amplifies a bad template into a
non-convergence) is absent when the task is shallow.

Two methodological results follow, and they are the durable output of this section:

1. **A loop on a non-deterministic model needs a statistical regression gate, not a fixed
   number.** Unit tests cannot catch loop regressions (109 stayed green while a one-line
   crystallization-prompt change collapsed the curve). The repository ships `npm run
   eval:loop`, which runs both curves and asserts the loop converges and does not collapse
   (events below the collapse band), the only form of assertion a non-deterministic loop
   admits.
2. **Hermetic cold start is a precondition for measuring emergence.** A benchmark that lets
   memory accumulate across runs measures DB history, not the loop, and invites
   after-the-fact causal stories on polluted data. Every curve now truncates all memory
   tiers before it starts.

The next lever for consolidation robustness, left as deliberate future work, is
quality-gated canonical updates: only a run at least as good as the current canonical may
update it, which breaks the closed loop a bad run otherwise uses to lock itself in.

## 6. Threats to validity

- Model capability; effect scales with hidden structure, not task size. A strong model
  infers most of a DAG, so the measurable effect is exactly the subset of structure it
  could not have known. Section 5.5 demonstrates this directly: an 18-step DAG whose
  quirks matched standard CI/CD practice produced zero effect (the model inferred all
  of them), and only when the quirks were redesigned to reverse the model's priors did
  the effect and the learning curve reappear, larger than the small DAG's. A null
  result is therefore not evidence that the loop fails; it can mean the task held no
  structure worth learning. The same point held on a toy trap whose severity, dialed
  from a recoverable 1-step mistake to a catastrophic one, moved the effect from about
  7% to "OFF cannot finish at all".
- Single trajectory (curve). Temperature 0 makes each run near-deterministic given its
  templates, so the curve is a clean step transition rather than a noisy average. It
  shows when learning happens, not a smoothed rate.
- Crystallization fidelity. Whether a crystallized template conveys the quirk to the
  next run depends on the model's intent and outcome extraction. The curve measures
  this end-to-end; it is a feature under test, not an assumption.
- The `recall` flag is a false negative. The harness's `recallHit` checks for the
  literal quirk tokens in the injected text, so the baseline curve logs `recall=false`
  even though a direct `mem::reflect` probe confirms templates were recalled (2 for the
  goal query). The flat baseline therefore reflects inert recalled content, not absent
  recall, which is the stronger and correctly diagnosed conclusion. The raw JSON keeps
  the conservative flag; this document reports the probed result.
- Harness-triggered `scope_closed`. The convergence decision is real; only its firing
  is harness-driven, because the control-plane daemon is not run in-loop.

## 7. Reproducibility

```
# A/B
VITEST=1 TEST_DB=postgres://.../graph_test <LLM env> \
  npx tsx scripts/eval/faithful-ab/run.ts ab 8
# learning curve
... npx tsx scripts/eval/faithful-ab/run.ts curve 10
```

Per-run records (events, gate failures, chosen order, recall, wall-time) are written
to `.harness/analysis/faithful-ab/{ab,curve}-<ts>.json` with the commit hash and
model. Apparatus: `scripts/eval/faithful-ab/{dag,seed,agent,run}.ts`.

## 8. Conclusion

Four results, in increasing importance.

1. L1 holds. When a template carries the actionable lesson, recall makes the agent
   deterministically better: zero quirk failures against 75% without. The injection
   mechanism is sound.
2. L3 holds, now. Two latent defects (D1, the unfalsifiable `hitRate`; D2, no
   convergence terminalizer) meant the loop's success path never fired in normal
   operation. Both are fixed (`11ef17e5`; `9ebd175a` / ADR-58). The runtime now
   converges, crystallizes, recalls, and reinforces end-to-end.
3. L2 was the gap; diagnosed, fixed, and the loop now delivers. With the plumbing
   fixed the learning curve was still flat, which exposed the real defect:
   crystallization distilled the executed trajectory including the cold run's mistake,
   so the agent reproduced its first flawed path on every run. Crystallizing the
   corrected order rather than the path taken makes the curve decline; the non-obvious
   mistake is made once and never again (26 to 24 across runs 1 and 2, flat-optimal
   thereafter).
4. It scales, and consolidating templates can reach the optimum but is not yet robust.
   On an 18-step DAG with six counter-intuitive quirks (Section 5.5) the autonomous curve
   declined 13% (46.7 to 40.7) and plateaued one quirk short of optimal because recall
   injected a mixture of partial runbooks. Consolidating them into one canonical runbook
   reached 38/0 in one run (Section 5.6) but did not reproduce: consolidation is a closed
   feedback loop, and on a non-deterministic model it is variance-fragile (LLM prose-merge
   drifts and compounds; no-merge collapses on incompleteness). This is documented as an
   open problem (Section 5.7), with quality-gated canonical updates named as the next lever.
5. The same instrument that found this is the lasting contribution. A loop on a
   non-deterministic model cannot be validated by unit tests (109 stayed green through a
   collapse) or by a single number; it needs a statistical regression gate over hermetic
   runs (`npm run eval:loop`). That gate, plus the finding that a hermetic cold start is a
   precondition for measuring emergence at all, is what makes every future change to the
   loop measurable. A second, naturally-occurring precondition (install a skill's CLI
   before use) is learned robustly, showing the loop generalizes beyond synthetic DAGs
   wherever the task is shallow enough that a bad template cannot lock itself in.

The benchmark converts a slogan into a measurement, falsifies the naive version,
localizes the failure to a precise mechanism (crystallization replays the trajectory
instead of distilling the corrected structure), and verifies the fix on the same
instrument. The general lesson is sharper than the bug: a learning system must distill
what should have happened, not record what did, or it reinforces its own first
mistakes. That is the core discipline of Loop Engineering, and re-running this harness
is its standing regression test.

### Provenance

- 11-step DAG, 2 quirks (Sections 4 and 5):
  - A/B: `.harness/analysis/faithful-ab/ab-1781565457508.json` (8 reps per arm)
  - curve, baseline (flat): `curve-1781565760663.json`
  - curve, after L2 fix (declining): `curve-1781567981220.json`
- 18-step DAG, 6 counter-intuitive quirks (Section 5.5, scaled validation):
  - A/B: `ab-1781570646578.json` (8 reps per arm, 12%)
  - curve, after L2 fix (declining 13%, plateau at 40): `curve-1781569692836.json`
- 18-step DAG, consolidation (Section 5.6):
  - curve, intent-keyed (regressed, mixture re-formed): `curve-1781579091655.json`
  - curve, topology-keyed (reached 38/0 in this draw): `curve-1781580434975.json`
- 18-step DAG, variance / non-reproduction (Section 5.7): multiple later curves on
  byte-identical code collapsed to 121 (e.g. `curve-1781586459371.json`,
  `curve-1781590563176.json`), establishing that the 38/0 was a draw.
- CLI-precondition task (Section 5.7, B2): `.harness/analysis/cli-precondition/curve-*.json`
  (discovery failure 1 cold then 0; apparatus `scripts/eval/cli-precondition/`).
- Model `openai/gpt-oss-120b` (NVIDIA hosted), temperature 0 but non-deterministic.
- Fixes: D1 (failure_count) `11ef17e5`; D2 (convergence terminalizer) `9ebd175a`,
  ADR-58 `docs/adr/0067-...`; L2 (corrected-order crystallization) `08c2af7f`;
  consolidation (topology-keyed merge-and-supersede) `b883fe8f` (variance-fragile, §5.7).
- Regression gate: `npm run eval:loop` (`scripts/eval/loop-gate.ts`); hermetic cold start
  in `scripts/eval/*/run.ts`. Apparatus at the 18-step DAG: `scripts/eval/faithful-ab/`.
