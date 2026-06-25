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

## Status

IN PROGRESS — step-1a (deterministic core mechanism) PASS. Step-2 (statistical
confirmation on live env) pending. Not yet VALIDATED until step-2's kill-criterion runs.
