# Does an agent runtime get measurably smarter with use? A causal benchmark of the Memex emergence loop

> **Status**: living benchmark document. Numbers are produced by
> `scripts/eval/faithful-ab/` against a live LLM and committed alongside the
> raw JSON in `.harness/analysis/faithful-ab/`. Re-runnable — see §7.

## Abstract

Memex claims an agent runtime that becomes more efficient *with use*: successful
execution structures are crystallized into procedural templates, recalled on
similar future tasks, and reinforced when they help. We test this claim causally,
not anecdotally. On a realistic 11-step "stand up a microservice" task with a
real dependency DAG and two non-obvious ordering quirks, we measure
**events-to-convergence** — the number of immutable ledger events a live LLM agent
emits before the task converges — under two designs: (A) a controlled A/B that
toggles template injection ON vs OFF, and (B) a learning curve in which the full
loop (crystallize → recall → reinforce) runs across repeated cold-start runs.

**Findings.** (A) Injection works: a recalled runbook deterministically eliminates
the non-obvious-quirk failures an uninjected agent hits ~75% of the time (ON 24.0±0.0
events / 0 gate failures vs OFF 25.5±0.9 / 0.8; Δ6%, magnitude bounded by how much of
the DAG a capable model already infers). (B) But the autonomous learning curve is
**flat** (25.3 → 26.0 over 10 runs): the loop converges, crystallizes, and recalls —
yet the agent is no faster on run 10 than run 1. The broken link is **crystallization
fidelity**: the produced template captures a generic "what happened" summary plus an
anonymized topology skeleton, not the actionable ordering lesson, so the recalled
artifact is inert. **越用越聪明 does not hold end-to-end today — because of *what*
crystallization distills, not because the loop fails to run.** The work also surfaced
and fixed two latent defects (an unfalsifiable success metric and a missing
convergence terminalizer) that had silently prevented the loop's success path from
ever firing — the prerequisite that made this measurement possible at all.

## 1. Introduction

The product thesis — *越用越聪明*, "smarter with use" — is an empirical claim about
a learning curve, not a feature checkbox. It can be true or false, and a system
that cannot measure it cannot be trusted to have it. This document builds the
measurement apparatus and reports what it shows.

We frame three causal links:

- **L1 — injection → efficiency**: does *recalling* a relevant procedural template
  make an agent reach the goal in fewer steps?
- **L2 — crystallization → template**: does a *converged* run produce a template
  that captures reusable structure?
- **L3 — the lifecycle**: does the runtime actually *converge* and *fire* the loop
  under normal operation?

L1 is isolated by the A/B (§4). L1+L2+L3 together are the learning curve (§5),
which is the direct test of the product thesis.

## 2. Background: the loop, and two defects that disabled it

The Memex loop (Phase 10, "trail discovery"): on scope close, a `TemplateProposalWorker`
crystallizes the converged event DAG into a procedural template; on later cold
starts, `mem::reflect` recalls templates by hybrid (vector + BM25) similarity and
injects them into the agent's context; converged reuse reinforces the template
(`success_count + 1`), decay supersedes the unused (Ebbinghaus).

Building the benchmark surfaced two latent defects that meant the **success side of
the loop never fired in normal operation**:

- **D1 — unfalsifiable success metric.** `trailDiscoveryHitRate =
  Σ success_count / Σ injection_count`, but nothing ever incremented
  `failure_count`. The metric was monotonic — it could only rise, never detect the
  loop getting worse (a Proxy-Signal anti-pattern). Fixed by a `failure_count` write
  path on non-converged terminal states (merged `11ef17e5`).
- **D2 — no convergence terminalizer (F-1).** The convergence SQL required every
  event row to be terminal, but no happy-path step terminalized a completed task —
  so scopes driven through the standard gateway + MCP path **never converged**, and
  `scope_closed` (which triggers crystallization + reinforcement) never fired.
  Live-verified with a probe: `is_converged=false` at every step, even for an empty
  scope. Fixed by ADR-58 (merged `9ebd175a`): converge on "every spawned task is
  done", with an `EXISTS(task_spawned)` guard so pure-conversation scopes (which
  record only `memory_updated`) are never auto-closed; `complete_task` terminalizes
  the task row.

Without D2 fixed, any learning-curve measurement would be trivially flat (no
convergence → no crystallization → no learning). The benchmark is therefore only
meaningful on a runtime where D2 is fixed — which is the contribution that made
this measurement possible at all.

## 3. Apparatus: a realistic long task with hidden structure

**Task.** "Stand up a new microservice" — 11 steps over a real dependency DAG:

```
scaffold → add_deps → write_api → containerize ┐
        └→ db_schema → gen_migrations ┐         ├→ deploy
start_db ───────────────────────────┴→ run_migrations → run_tests ┘
write_api → write_tests ──────────────────────────────┘
```

Most edges are intuitive (scaffold first, deploy last). Two are **non-obvious
quirks** an agent cannot infer from names and that only a learned runbook carries:

- **Q1**: `run_tests` requires `containerize` first (tests run inside the container)
- **Q2**: `gen_migrations` requires `add_deps` first (the migration tool is a project dependency)

The goal text lists the steps **alphabetically** and never reveals the dep graph.
An agent that respects only the intuitive deps still trips Q1/Q2 → a **gate failure**
→ rework. The injected runbook encodes the full topological order including the quirks.

**Dependent variable.** *events-to-convergence*: the count of immutable ledger
events in the scope when `scope_closed` is written. Each step is one real MCP
`spawn_subtask → claim_next_task → complete_task` round trip (≈2 events); a gate
failure adds a failed attempt (≈2 events of pure waste). Guardrail: the convergence
boolean (real `checkConvergence`) and goal-achievement (all 11 steps completed).

**Faithfulness.** The agent drives the task through the **real** MCP tools, so
`complete_task`'s ADR-58 terminalizer fires and convergence is the runtime's own
decision — no measurement shim. The only harness-side action is triggering the
`scope_closed` write that the control-plane watchdog makes in production (the
convergence *decision*, `checkConvergence`, is the real one). The dependency gate
is the task's environment, not a measurement artifact.

**Model & controls.** Live `[MODEL]`, temperature 0. Same task text, same golden
template seed, same `w_max`, same gate across arms; the only manipulated variable is
procedural injection (`MEMEX_INJECT_PROCEDURAL` → `inject_procedural`). Embedding
recall degraded to BM25 when the embedding endpoint is unavailable (ADR-55) — the
injection mechanism is unchanged; recall route differs.

## 4. Experiment A — A/B: injection → efficiency (L1)

Golden runbook direct-seeded (isolates L1 from L2). The same task runs N=8 times
per arm with injection ON vs OFF; we compare events-to-convergence. Model
`openai/gpt-oss-120b`, temperature 0, BM25 recall.

| arm | events-to-convergence | gate failures / run | recall | converged | goal |
|---|---|---|---|---|---|
| **ON**  | **24.0 ± 0.0**  (all 8 = 24) | **0.0** | 100% | 8/8 | 8/8 |
| **OFF** | 25.5 ± 0.9  [24–26] | 0.8 (6/8 tripped a quirk) | — | 8/8 | 8/8 |

Δ = **6% fewer events with injection** (24.0 vs 25.5).

**Reading.** The signal is not in the headline 6% but in its *mechanism and
reproducibility*. The ON arm is perfectly deterministic — 24 events, **zero** gate
failures across all 8 runs: the recalled runbook makes the agent respect the
non-obvious quirks every time. The OFF arm trips a quirk in **6 of 8 runs** (the
other 2 ordered correctly by luck), each paying one failed attempt (~2 wasted
events). So injection **eliminates** a failure the uninjected agent hits ~75% of the
time. The magnitude is small only because a capable model (gpt-oss-120b) infers the
*rest* of the 11-step DAG unaided; the effect is exactly the size of the **hidden,
non-inferable structure** the template supplies — here two quirks. This is the L1
result: recall → fewer events, deterministically, concentrated on what the agent
could not have known.

## 5. Experiment B — learning curve: 越用越聪明 (L1+L2+L3)

Cold start (`procedural_memory` wiped). The task runs N=10 times with the **full
loop**: injection ON, and after each converged run the `TemplateProposalWorker`
crystallizes the run into a template the next run can recall. We measure whether
events-to-convergence trends **down** across runs. Model `openai/gpt-oss-120b`,
temperature 0, **functional embedding** (hybrid recall).

| run | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|---|
| events | 26 | 24 | 26 | 26 | 26 | 26 | 26 | 26 | 26 | 26 |
| gate failures | 1 | 0 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 |
| templates after | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |

first-third mean **25.3** → last-third mean **26.0** — **no learning** (−3%, i.e.
flat-to-slightly-worse; run 2's 24 is the same ~25% lucky-ordering hit seen in the
A/B OFF arm, not a learned gain). The curve does **not** decline.

### Why it is flat — the broken link is crystallization fidelity (L2), not plumbing

The loop *runs*: every run converges (post-#29), a template is crystallized
(count grows 1→10), and recall fires — a direct probe confirms `mem::reflect`
recalls **2** templates for the goal query. So L3 (convergence) and recall both
work. The defect is in **what crystallization produces**:

- crystallized **intent** is a generic "what happened" summary —
  *"Create a faithful-ab microservice with full scaffolding, dependencies, database,
  API, migrations, tests, containerization, and deployment."* It records the steps
  taken, **not the hard-won ordering lesson** (`containerize` before `run_tests`).
- crystallized **template_graph** is the WL-canonicalized skeleton with **anonymized
  node IDs** (`{"from":"n0","to":"n13"}`): an opaque topology the agent cannot map
  back to step names or dependencies.

So the recalled artifact is **inert for the task**: it neither states nor structurally
encodes the constraint that caused the failure, so the agent trips the same quirk on
run 10 as on run 1. Contrast the A/B's hand-written runbook, which says the order
explicitly and *does* eliminate the failure (§4). **A good template helps (L1); the
loop's autonomous crystallization does not produce a good template (L2).**

This is the central, falsifiable finding: **"越用越聪明" does not hold end-to-end in
the current implementation — not because the loop fails to run (it does, post-#29),
but because crystallization distills a run into an artifact too generic and too
anonymized to transfer the actionable lesson.** The remedy is specific: crystallization
must capture *actionable structure* — the ordering/dependency constraints, with
readable step labels — rather than a prose summary plus an anonymized skeleton.

## 6. Threats to validity

- **Model capability.** A strong model infers most of the DAG, so the effect
  concentrates on the non-obvious quirks; effect size scales with the density of
  hidden structure, not with whether the loop works. (Established earlier on a toy
  trap whose severity, when dialed from a recoverable 1-step mistake to a
  catastrophic one, moved the effect from ~7% to "OFF cannot finish at all".)
- **Single trajectory (curve).** temperature 0 makes each run near-deterministic
  given its templates, so the curve is a clean step transition rather than a noisy
  average; it shows *when* learning happens, not a smoothed rate.
- **Crystallization fidelity.** Whether a crystallized template actually conveys the
  quirk to the next run depends on the LLM intent/outcome extraction; the curve
  measures this end-to-end (it is a feature under test, not an assumption).
- **`recall` flag is a false-negative.** The harness's `recallHit` checks for the
  literal quirk tokens in the injected text; the curve logs `recall=false` even
  though a direct `mem::reflect` probe confirms templates *were* recalled (2 for the
  goal query). The flat curve therefore reflects *inert recalled content*, not
  *absent recall* — the stronger and correctly-diagnosed conclusion. The raw JSON
  retains the conservative flag; this document reports the probed truth.
- **Harness-triggered scope_closed.** The convergence decision is real; only its
  firing is harness-driven (the control-plane daemon is not run in-loop).

## 7. Reproducibility

```
# A/B
VITEST=1 TEST_DB=postgres://…/graph_test <LLM env> \
  npx tsx scripts/eval/faithful-ab/run.ts ab 8
# learning curve
… npx tsx scripts/eval/faithful-ab/run.ts curve 10
```

Raw per-run records (events, gate failures, chosen order, recall, wall-time) are
written to `.harness/analysis/faithful-ab/{ab,curve}-<ts>.json` with the commit
hash and model. Apparatus: `scripts/eval/faithful-ab/{dag,seed,agent,run}.ts`.

## 8. Conclusion

Three results, in increasing importance:

1. **L1 holds.** When a template carries the actionable lesson, recall makes the
   agent deterministically better — zero quirk failures vs ~75% without. The
   injection mechanism is sound.
2. **L3 holds — now.** Two latent defects (D1 unfalsifiable `hitRate`, D2 no
   convergence terminalizer) meant the loop's success path never fired in normal
   operation. Both are fixed (`11ef17e5`, `9ebd175a`/ADR-58). The runtime now
   converges, crystallizes, recalls, and reinforces end-to-end.
3. **L2 is the gap, and the thesis does not yet hold.** With the plumbing fixed,
   the autonomous learning curve is still flat: crystallization distills a run into
   a generic summary plus an anonymized topology, which recall faithfully returns
   and which is then *inert* — it does not transfer the ordering knowledge that
   distinguishes a fast run from a slow one. **越用越聪明 is currently false
   end-to-end, for a precise and fixable reason.**

The value of this benchmark is that it converts a slogan into a measurement and
localizes the failure: not "the loop doesn't work" but "crystallization must encode
actionable structure (ordering/dependency constraints with readable labels), not a
prose summary over an anonymized skeleton." That is the next experiment's hypothesis
and the next implementation's target. Re-running this harness after a crystallization
change is the regression test for the core product claim.

### Provenance
- A/B: `.harness/analysis/faithful-ab/ab-1781565457508.json` (8 reps/arm)
- curve: `.harness/analysis/faithful-ab/curve-1781565760663.json` (10 runs)
- code at commit of record; model `openai/gpt-oss-120b`, temperature 0.
- Defect fixes: D1 `11ef17e5`, D2 `9ebd175a` (ADR-58 `docs/adr/0067-...`).
