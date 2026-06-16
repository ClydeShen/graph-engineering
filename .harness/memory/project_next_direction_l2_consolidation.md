---
name: next-direction-l2-consolidation
description: "Planned next direction from the Loop Engineering benchmark: L2 template consolidation so the learning curve reaches the optimum at scale. Plus secondary tracks + 2 infra issues."
metadata: 
  node_type: memory
  type: project
  originSessionId: 631b156a-499a-43fe-acef-2fa43aa55b8f
---

2026-06-16 handover plan, derived from the benchmark (`docs/benchmarks/emergence-loop-validation.md`, master `6a12ba8e`). The loop now works end-to-end (L1/L2/L3 green); the research names the next target precisely.

## PRIMARY (evidence-backed): L2 template consolidation
**Problem (paper §5.5 + conclusion):** at 18 steps / 6 counter-intuitive quirks the learning curve **plateaus at 40, one quirk short of the 38 optimum**. Cause: templates accumulate (1→10 over runs) and `mem::reflect` injects a **mixture** of partial corrected runbooks instead of one consolidated runbook. Each template captures *most* of the 6 reversed rules, none all.
**Hypothesis:** a consolidation step that yields ONE canonical corrected runbook lets the curve reach the optimum (≈38, 0 residual gate failures).
**Two design options to weigh first (discuss):**
- (a) **Crystallization-time merge** — on close, supersede the prior same-fingerprint template with a merged superset of the corrected order. Aligns with existing supersede + Ebbinghaus machinery (`superseded_by`).
- (b) **Recall-time fuse/select** — `mem::reflect` picks the single most-complete template or fuses top-k into one injected runbook (dedup the rules).
**Falsifiable experiment:** implement consolidation → re-run the 18-step curve (`scripts/eval/faithful-ab/run.ts curve 10`) → success = curve reaches ~38 / steady 0 gate failures. Same harness is the regression test.

## SECONDARY (lower priority, also surfaced)
- **Cross-task recall** (the "cross-domain topology" vision): current benchmark repeats ONE task. A 2-task experiment (template from task A helping related task B) tests genuine generalization, not memorization.
- **Reinforcement/decay over long horizons**: short curves don't stress `success_count` accumulation or supersede-on-decay. A longer-horizon run would.

## INFRA ISSUES worth filing (from the live runs)
- **F-INFRA-1**: `memex doctor` reports LLM/embedding "reachable" via a bare `GET` on baseUrl (doctor.ts:160,193) — never a real chat/embed. A keyless endpoint passes doctor but 500s on use. Fix = make the probe do a real minimal call.
- **F-INFRA-2**: LLM API key lives only in repo `.env` (`LLM_API_KEY`/`NVIDIA_API_KEY`), not in `~/.memex/config.json`; standalone processes that don't load `.env` build keyless providers and 500. Fix = resolve/merge the key into config, or document the requirement.

## State
master `6a12ba8e` clean; only `exp/emergence-ab-harness` (toy, unmerged, preserved) branch remains. Benchmark + harness + 5 raw JSON + ADR-58 + README link all on master. Recommend starting the consolidation track at **discuss** (pick option a vs b) before coding.

关联：[[emergence-benchmark-paper]] [[emergence-loop-validation]]
