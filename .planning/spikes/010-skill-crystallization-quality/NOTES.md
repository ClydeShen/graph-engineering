# Spike 010 — Crystallization robustness (PoC-1, the kill-test)

落点: `docs/VALIDATION-PLAN.md` PoC-1 / `docs/LEARNING-ENGINE-REFRAME.md` §3
分支: `poc/learning-engine-validation`
日期: 2026-06-25

## The claim under test (§3 hypothesis)

NOT "can crystallization distil a corrected sequence once" — the emergence benchmark
already showed it can (L2 fix `08c2af7f`: 26→24 step-change) but **variance-fragile** (a
good sample; two later fixes were gate-falsified).

PoC-1 tests the sharper, unproven claim: **does crystallizing to an *executable,
test-verified skill* (instead of a free-form text Lesson) make the distillation ROBUST
across repeated runs — killing the variance the text-Lesson form had?**

## Kill-criterion

- ✅ PASS = the crystallized **executable skill** (a) yields the optimal sequence (distils
  "what should be", excludes the cold-start misstep) AND (b) `npm run eval:loop` shows it
  is **statistically stable across N runs** (no bimodal collapse) — i.e. measurably less
  variance than the text-Lesson baseline on the same trajectory.
- ❌ FAIL = output reproduces the walked error path (old disease), OR is
  non-executable / non-reusable, OR the gate shows the same variance-fragility as text
  Lessons (then: the executable form is NOT the robustness lever — stop, rethink the
  crystallizer before building anything downstream).

## Reuse existing assets (do NOT invent a trajectory)

- `scripts/eval/faithful-ab/` — the messy cold-start trajectory
  (`run_tests → containerize → run_tests retry`) and the real MCP-driven #29 convergence.
- `npm run eval:loop` (`scripts/eval/loop-gate.ts`) — the statistical loop gate that
  caught the prior over-claims. This is the robustness instrument.
- Sample task = a coding task with an **objective test oracle** (containerize-before-tests
  gotcha) so verification is automatic — removes the human-oracle confound (that is PoC-3).

## Design decision — RESOLVED 2026-06-25

Skill artifact form = **typed step-DAG / runbook** (smallest bridge from the current
crystallize path; directly assertable against the real `DEPS`; reuses the Experiment-A
`runbookContradictsDag` idea).

## Grounding findings (read from real code)

- **Text-Lesson baseline already exists**: `faithful-ab/dag.ts` `GOLDEN_INTENT` is exactly
  the free-form prose form ("write_api before db_schema; … Correct order: …"). That is the
  control.
- **Typed-graph infra exists** but at the wrong abstraction: `template-graph.ts`
  `TemplateGraph` is canonical/WL-comparable, but labels are **event_type** topology, not
  **domain step ordering**. PoC-1 needs the step-order layer (the 6 reversed rules).
- **Experiment-A `admission.ts` (`runbookContradictsDag`) is NOT on this branch** (it lives
  on `exp/admission-verifier`). Re-derived a minimal verifier in `step-dag.ts` from
  `dag.ts` `DEPS` → keeps this branch clean off master, no cross-branch entanglement.

## Result — step-1a (deterministic core) ✅ PASS

`step-dag.ts` (run: `npx tsx .planning/spikes/010-skill-crystallization-quality/step-dag.ts`)
proves the robustness **mechanism** without a live LLM: 4/4 assertions.

- A correct crystallization passes both forms.
- A corrupted rule (db_schema before write_api): the **step-DAG verifier rejects it
  upstream** (order + rule contradiction caught); the **text Lesson passes silently** (no
  checkable structure).
- → Verifiability-at-crystallization-time is the lever: it converts "store an incorrect
  lesson" (the prior arc's death) into a *rejectable event*.

## Remaining — step-2 (statistical confirmation, needs live env)

The deterministic core shows *why* the typed form is more robust; it does not yet show the
*statistical* efficacy on real LLM runs. Step-2:

1. Baseline: run text-Lesson crystallization on the faithful-ab trajectory M times →
   variance/collapse profile via `npm run eval:loop` (control).
2. Wire the step-DAG verifier as a crystallization gate; run the same trajectory M times.
3. Compare variance; apply the kill-criterion.

**Env needed**: live DB + reachable LLM (faithful-ab is real-MCP). Confirm
`npm run eval:loop` runs green locally before step-2.

1. Baseline capture: run the existing text-Lesson crystallization on the faithful-ab
   trajectory M times → record the variance/collapse profile via `eval:loop` (the control).
2. Minimal executable-skill crystallizer variant (per the decided form) — smallest change
   to the crystallize path that emits an executable, test-verifiable artifact.
3. Run the *same* trajectory M times through the executable-skill path → `eval:loop`.
4. Compare variance: executable-skill vs text-Lesson. Apply the kill-criterion.
5. Record result in `MANIFEST.md` (VALIDATED / INVALIDATED + one-line finding).

## Environment needed to execute

PoC-1 drives the real eval harness → needs the live DB + an LLM provider reachable
(faithful-ab is real-MCP, not stubbed). Confirm `npm run eval:loop` runs green locally
before step 1.

## PoC-2 result — meta-cue trigger reliability (deterministic core) ✅ PASS

(Hosted in this dir for now; logically a separate PoC — `meta-cue.ts`. Run:
`npx tsx .planning/spikes/010-skill-crystallization-quality/meta-cue.ts`)

Models the 6 reversed-intuition quirks (dag.ts Q1–Q6) as the ground-truth trap points a
*strong* agent trips on (minority: 6/18). 6/6 assertions:

| strategy | precision | recall | F1 |
|---|---|---|---|
| always-on (push everything) | 33% | 100% | 50% — **noise** |
| always-off (pure pull) | 0% | 0% | 0% — **blind** |
| seed-prior (k=0, ≥2 prereqs) | 29% | 33% | 31% |
| **learned (full traces)** | **100%** | **100%** | **100%** |

- The cue fed by accumulated failure traces converges to fire **exactly** at the trap
  points (P=R=100%), strictly dominating push-everything and pure-pull. Learning curve is
  monotone 0→100% over 6 runs.
- **Honest finding (refines reframe §4):** a *generic* seed prior is **weak** for
  domain-specific reversed-intuition quirks (P=29%/R=33%, barely above noise). Pre-fab
  seeds make cold-start *non-empty* but they are **not** the lever — **learning from real
  failure traces is**. The §4 meta-crystallization family should lean on accumulation, not
  expect strong hand-authored seeds.

Modeling note: an earlier version used a naive *alphabetical* agent as ground truth → it
trips 16/18 steps, making "push everything" look 89%-precise. That models a *weak* agent
and hides the cue's value; the honest case is the strong agent whose only blind spots are
the 6 quirks. Corrected.

## PoC-3 result — end-to-end error-transfer + oracle gate (deterministic core) ✅ PASS

(`error-transfer.ts` — integrates PoC-1 verifiability + PoC-2 cue into the full loop.) 7/7.

Error-transfer curve (events-to-convergence, optimal = 18):

```
  run:          0  1  2  3  4  5  6
  oracle ON:   24 23 22 21 20 19 18     monotone → optimal (越用越聪明)
  oracle OFF:  24 23 22 21 22 21 20     poisoned at run 3, never reaches 18
```

- Verified-skill accumulation **transfers error**: cold start = 24 (18 steps + 6 quirk
  reworks, matches the benchmark), falling monotonically to the optimal 18.
- **The oracle gate is load-bearing**: remove it and one consistent-but-wrong
  crystallization permanently poisons the skill set → the curve never converges (the prior
  arc's bimodal collapse). This is PoC-1's verifiability proven *inside the loop*.

## PoC-4 result — stigmergic multi-agent convergence (deterministic core) ✅ PASS

(`stigmergy.ts` — exercises the split-control decision.) 9/9.

- 3 agents coordinating **only through shared traces** (no central controller) complete the
  whole DAG **exactly once**, **in parallel** (12 rounds < 18 steps), and **terminate**.
- **Environment physics** (mechanical, never decides who acts): OCC arbitration → no step
  executed twice; termination detected; an **injected cycle is caught as deadlock** (the
  liveness floor) instead of hanging.
- 1 agent also converges (18 rounds, no starvation). Confirms agent-firing = stigmergy,
  control-floor = environment physics — exactly the split-control boundary.

## Status — PAUSED (decision 2026-06-26: stop at de-risked mechanisms)

All four mechanisms proven **deterministically** (no live LLM):
PoC-1 (crystallization verifiability) · PoC-2 (meta-cue is a real signal) ·
PoC-3 (error-transfer + load-bearing oracle gate) · PoC-4 (stigmergic convergence + physics
floor). **None is VALIDATED** — that requires the live statistical step.

**Live confirmation = a separate batch, deferred until the env is ready.** It is NOT
abandoned; the deterministic cores de-risk the *logic*, the live batch confirms the
*statistics* on real LLM trajectories.

### Resume-here (the live batch)
Preconditions: live DB + reachable LLM provider; `npm run eval:loop` runs green.
1. Wire the step-DAG verifier (`step-dag.ts`) as a crystallization gate in the real path.
2. Baseline: text-Lesson crystallization on the faithful-ab trajectory M times → variance
   via `eval:loop`. Then the step-DAG-gated path M times. Compare (PoC-1/PoC-3 live).
3. Apply each PoC's kill-criterion; record VALIDATED / INVALIDATED in `MANIFEST.md`.

(Dir name is PoC-1-specific but now hosts all four deterministic cores: `step-dag.ts`,
`meta-cue.ts`, `error-transfer.ts`, `stigmergy.ts`.)
