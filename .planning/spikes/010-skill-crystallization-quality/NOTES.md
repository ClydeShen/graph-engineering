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

## Tracer-bullet plan (sync the ONE design decision below before coding)

**Open decision (needs alignment before code — per repo "sync before writing code"):**
what is the *executable skill* artifact form the crystallizer emits? Candidates:
(a) a typed step-DAG / runbook the runtime can replay & assert against; (b) an actual
executable program/script gated by a test; (c) a parameterized tool-call template.
→ This choice sets what "executable + test-verified" means for the gate. **Decide first.**

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

SCAFFOLD — not started. Blocked on the one design decision (skill artifact form) above.
