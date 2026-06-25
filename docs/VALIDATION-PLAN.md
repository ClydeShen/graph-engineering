# Memex Learning-Engine — Validation Plan (PoCs)

- **Status**: Proposed (the operational counterpart to `LEARNING-ENGINE-REFRAME.md` / `PRODUCT-DEFINITION.md`)
- **Date**: 2026-06-25
- **Purpose**: enumerate the design's *unproven, load-bearing* assumptions and the cheap,
  falsifiable PoCs that de-risk each — **before** any large build toward serving external
  agents.

The design is high-confidence on *buildable* and *directionally right*; the open unknown
is **efficacy on real tasks**. This plan breaks that single big bet into PoCs ordered by
"which assumption, if false, collapses everything downstream."

---

## Weak links (unproven assumptions)

| # | Assumption | Confidence | Why it's a weak link | Isolable? |
|---|-----------|-----------|----------------------|-----------|
| **1** | Crystallization can distil a *messy first trajectory* into a **clean, correct, reusable executable skill** — *robustly*, not just in a lucky sample | low–med | The prior arc died here (text Lessons reproduced the walked error path; the one good 18-step consolidation was a fragile sample, two follow-up fixes were gate-falsified). The whole reframe bets that the **executable-skill form** makes this *robust*. Unproven. | ✅ very cheap |
| **2** | The **meta-cue reflex** fires at the right decision points (cues when history matters, stays quiet otherwise) — without over/under-triggering | low | Pure pull → "doesn't look before it leaps" → the error library goes unconsulted → engine idles. Cold-start + training signal is an openly-deferred seam. | ✅ medium |
| **3** | **Human-as-oracle** works as a crystallization gate without becoming a throughput bottleneck (cost per skill; signal cleanliness) | med | Human-in-loop is a design pillar but its cost is unmeasured. If every skill needs heavy human confirmation, cross-task compounding is throttled by human effort. | ◑ needs a real human |
| **4** | **Stigmergic multi-agent coordination** converges (planner/implementer/verifier coordinate via graph traces, no central controller) instead of starving / duplicating / live-locking | med | Split-control is a new design; the "environment physics" floor is still theoretical. | ◑ needs ≥2 agents |
| — | Independent verifier with asymmetric tooling (deterministic DAG admission) | **higher** | **Already PoC'd** — Experiment A (`exp/admission-verifier`). Partially de-risked. | done |

---

## PoC sequence (kill-tests)

```
PoC-1  crystallization ROBUSTNESS (kill-test, first)
   ├─ pass → PoC-2  meta-cue trigger reliability (isolated)
   │           └─ pass → PoC-3  end-to-end error-transfer (MemexTerminal; = 1+2+verifier+recall)
   └─ fail → STOP. fix the crystallizer before building anything downstream.
PoC-4  stigmergic multi-agent convergence → deferred until single-agent transfer holds.
```

### PoC-1 — crystallization robustness (the kill-test)

**Refined claim (grounded in the existing benchmark):** the question is *not* "can
crystallization distil a corrected sequence once" — the emergence benchmark already showed
it can (the L2 fix `08c2af7f`: 26→24 step-change). The benchmark also showed that result
was **variance-fragile** (a good sample; two later fixes gate-falsified). So PoC-1 tests
the **§3 hypothesis**: does crystallizing to an **executable, test-verified skill** make
the distillation **robust across repeated runs** — killing the variance that text-Lessons
had?

- **Reuse existing assets**: the `scripts/eval/faithful-ab/` messy trajectory (cold-start:
  `run_tests → containerize → run_tests retry`) and `npm run eval:loop` (the statistical
  loop gate). The sample trajectory already exists — do **not** invent one.
- **Sample task**: a coding task with an **objective test oracle** (containerize-before-tests
  gotcha) — chosen so verification is automatic, removing the human-oracle confound (that
  belongs to PoC-3).
- **Kill criterion**:
  - ✅ pass = the crystallized **executable skill** yields the optimal sequence (distils
    "what should be", excludes the cold-start misstep) **and the loop gate shows it is
    statistically stable across N runs** (no bimodal collapse).
  - ❌ fail = output reproduces the walked error path (the old disease), or is
    non-executable / non-reusable, or the gate shows the same variance-fragility as the
    text-Lesson form.

### PoC-2 — meta-cue trigger reliability

Seed the retrieval reflex with the conservative prior; on a handful of tasks where history
exists, measure true-positive cue (fires when a known trap applies) vs false-positive cue
(fires on noise). Kill = cannot separate signal from noise above a usable margin.

### PoC-3 — end-to-end error-transfer (the proving ground)

§7 of the reframe. Real-task suite where a class of error recurs; metric = does attempt N
avoid attempt 1's mistake faster than cold, under human-primary + test-fallback oracle.
This integrates PoC-1 + PoC-2 + verifier + recall — runs only after 1 and 2 pass.

### PoC-4 — stigmergic multi-agent convergence

Two+ agents (planner + implementer + verifier) coordinating via graph traces on one task —
do they converge without a central orchestrator? Deferred until single-agent transfer holds.

---

## Where the work lives

- **This plan** stays on `master` (stable reference).
- **PoC work** happens on a dedicated branch (`poc/learning-engine-validation`), as spikes
  under `.planning/spikes/` per the repo convention (NOTES.md + explicit kill-criterion),
  starting with `010-skill-crystallization-quality` (PoC-1).
