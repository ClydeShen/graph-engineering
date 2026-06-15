# Emergence-Loop A/B — Experiment Design (controlled-harness go/no-go)

Status: DESIGN (not yet built). Parent: GH #24. Blocker for the faithful version: GH #29 (F-1).
Decision locked 2026-06-16: run the **controlled harness first** to de-risk before investing in #29.

## 1. Objective

Answer one causal question cheaply, before committing to the F-1 lifecycle fix:

> **Does injecting a recalled procedural template make a live LLM agent reach the
> goal in fewer ledger events than the same agent with injection off?**

A positive signal justifies fixing F-1 (#29) and running the faithful A/B. A null
signal says the loop adds nothing — go fix retrieval/crystallization, don't build
hardening on top.

### Why a controlled harness (not the production path)
F-1: production scopes never converge (no happy-path task terminalizer), so the
production `events-to-convergence` signal is unmeasurable today. The harness
**decouples two links**:
- L1: injection → agent efficiency  ← *this experiment tests L1 in isolation*
- L2: crystallization → template quality (production seeding)
- L3: convergence lifecycle (F-1 / #29)

The harness simulates L3 (the runner terminalizes completed tasks, standing in for
the #29 fix) and short-circuits L2 (the golden template is direct-seeded). That
isolates L1, the load-bearing assumption under the whole vision.

## 2. Use case — trap task ①: ordered pipeline with a gated step

Goal given to the agent: *"Process the dataset to completion."*

Hidden structure (the environment enforces it): the real order is
`validate → transform → checkpoint → load`. The non-obvious constraint:
**`load` fails unless `checkpoint` ran first**. A failed `load` writes a deviation
event and must be retried after a `checkpoint` — that failure+retry cycle is the
measurable cost the shortcut avoids.

- **OFF arm** (no injection): the LLM most often tries validate→transform→load,
  hits the gate failure, diagnoses, inserts checkpoint, retries load → converges
  with the extra failure+retry events.
- **ON arm** (injection): the golden template encodes the correct order; the LLM
  reads it and runs validate→transform→checkpoint→load straight → converges with
  no failure cycle.

Effect size is engineered (we control the gate), so 3–5 reps/arm clear LLM noise.

### Golden template (direct-seeded into procedural_memory before both arms)
- `intent_description`: "Process a dataset end-to-end: validate, transform,
  checkpoint, then load. load REQUIRES a prior checkpoint."
- `template_graph`: canonical nodes `[validate, transform, checkpoint, load]` with
  edges encoding that order (built via the existing `buildTemplateGraphFromEvents`
  + `canonicalizeTemplateGraph` so it is a faithful template, not hand-JSON).
- `intent_embedding`: embedded via the live bge-m3 provider so hybrid recall fires.
- Seeded once; both arms share the identical seed corpus.

## 3. Harness mechanics

Per rep (fresh scope each time):
1. Create scope via gateway `buildApp` (graph_test, isolated; `VITEST=1` to skip listen).
2. **Agent loop** (live LLM, max ~12 steps as a safety cap):
   a. Assemble context for the scope (`assembleContext`) — this is where the
      procedural block is injected/omitted per `MEMEX_INJECT_PROCEDURAL`.
   b. Build the LLM prompt: goal + allowed actions (`spawn_step{name}`,
      `complete_step{id}`, `declare_done`) + the assembled context.
   c. Call the live LLM (nvidia, confirmed reachable). Parse one action.
   d. Apply the action via the MCP core tools (spawn_subtask / complete_task).
   e. **Gate environment**: if the agent completes `load` with no prior completed
      `checkpoint` in the scope, the runner writes a deviation (a `memory_updated`
      with `outcome=failed`, mirroring an orphan/conflict) and the step is not
      counted as progress — the agent must recover.
   f. **Terminalizer (stands in for #29)**: when a step is genuinely completed,
      the runner sets its ledger rows to `terminated`, so the convergence SQL can
      actually flip — this is the only production-divergent shim, and it is exactly
      what #29 will make real.
   g. Stop when `checkConvergence().isConverged` (all steps terminal, no open
      deviations) or the step cap is hit (record as non-converged).
3. **Measure**: events-to-convergence = count of ledger events in the scope DAG at
   the moment `scope_closed` is written; plus the convergence boolean.
4. Clean up the scope partition.

## 4. Experimental controls

| Knob | Held constant across arms |
|---|---|
| Task text | identical |
| Golden template seed | identical (seeded once, before both arms) |
| LLM provider / model / temperature / w_max | identical |
| Gate environment + step cap | identical |
| Only difference | `MEMEX_INJECT_PROCEDURAL` ON vs OFF |

## 5. Sample, dependent variable, analysis

- **Independent variable**: injection ON / OFF (already implemented).
- **Dependent variable**: events-to-convergence (continuous). Guardrail: convergence
  boolean (a run that hits the step cap without converging is recorded, not dropped).
- **Sample**: 5 reps/arm (10 runs total). Report per-arm mean + min/max spread and
  the convergence rate.
- **Decision rule**:
  - **GO** (positive): ON mean materially below OFF mean (target ≥ ~30% fewer
    events) AND ON convergence-rate ≥ OFF. → fix F-1 (#29), run faithful A/B.
  - **NO-GO** (null): ON ≈ OFF within spread. → the loop adds nothing in the easy
    case; redirect to retrieval/crystallization quality before any hardening.

## 6. Confounds & mitigations

- **LLM nondeterminism** → multiple reps; report distribution not single runs;
  engineered large effect.
- **Prompt leakage** (the goal prompt itself hinting the order) → the OFF-arm prompt
  must NOT state the checkpoint constraint; only the injected template (ON arm)
  carries it. Audit both prompts for parity except the injected block.
- **Recall miss** (template not retrieved even when injection ON) → assert the
  injected context actually contains the procedural block each ON rep; a rep where
  recall failed is a recall-quality data point, logged separately, not silently a null.
- **Harness terminalizer bias** → it is identical across arms, so it cannot create a
  between-arm delta; it only makes convergence reachable at all.

## 7. What this is / isn't

- IS: an isolated test of injection→efficiency (L1), and a go/no-go gate on the
  F-1 investment.
- IS NOT: the faithful production A/B (that needs #29), nor a test of crystallization
  quality (L2), nor an architecture decision itself — it gates one.

## 8. Open knobs (decide at build)
- Step cap value (12?) and target effect threshold (30%?).
- Whether the gate-failure writes a `conflict_detected` vs a `memory_updated{failed}`
  (affects how convergence/deviation is counted) — pick the one that matches how
  #29 will model a failed step.
- Keep the harness as a committed regression eval, or delete after the go/no-go.
