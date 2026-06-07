---
name: token-budget-design-concluded
description: Token budget prediction design effort was concluded as over-design on 2026-06-07 — do not re-open without new evidence
metadata:
  node_type: memory
  type: project
  originSessionId: dfe88d71-1f58-4f26-9b91-8585b9e49962
---

The "token-budget-prediction-design" effort (phase 04-external-integrations) was formally closed on 2026-06-07 as **over-design** — not implemented, no new ADR written.

**Why:** A multi-session /grill-me had built up a design (template-level token_stats schema, 3-phase regression prediction, pushed volatile budget snapshots, a new "ADR 56 sovereign isolation" guardrail) resting on a false premise: that the system needs something like manual `/compact` to avoid context drift. It doesn't — `ReverseChronologicalDiscarder` (ADR 30 D-2) already handles overflow deterministically and invisibly to the primary LLM, and ADR 30 explicitly abolished "Option B: synchronous LLM compression." The one residual concern (lossy drops losing causal info the Worker still needs) is already covered by ADR 13's rare escalation chain (small local-model-assisted distillation, only in catastrophic `Size(N_root)+Size(N_current) > W_max` cases). The proposed design's posture — continuous statistical prediction pushed to the *primary* LLM so it can make strategic decisions — runs opposite to the original architecture's posture (mechanism layer absorbs pressure invisibly; primary LLM stays budget-blind).

**Decision:** No new schema/worker/tool/ADR will be built for this. No residual "minimal pull-based query" version either — no observed pain point drives it, and ADR 30 already authorizes Workers to re-query the graph on their own initiative if they ever need to.

**How to apply:** If token-budget / context-prediction / "give the LLM budget awareness" comes up again in this project, do not restart design discussion from scratch — point to this conclusion and to `.harness/analysis/token-budget-prediction-design.md` (full rationale + conclusion section). Only reopen if genuinely new evidence surfaces (e.g., an observed real incident of Workers losing needed causal info to the discarder). See [[reanchor-on-original-design-when-drifted]].

Full writeup: `.harness/analysis/token-budget-prediction-design.md` (status: CONCLUDED). Closure record: `.harness/phases/04-external-integrations/.continue-here.json`.
