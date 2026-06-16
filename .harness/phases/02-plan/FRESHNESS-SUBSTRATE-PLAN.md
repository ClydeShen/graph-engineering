# Freshness-substrate build arc — PLAN mirror

> Canonical record = GitHub Issues **#30–#35** (ClydeShen/graph-engineering).
> This file is the local GSD mirror. Spec: `.harness/implementation-notes.md`
> §"Freshness-substrate design discuss (2026-06-17)".
> (The sibling `02-PLAN.md` is the historical Phase-02 plan — left untouched.)

Constants are config-externalized in every slice and calibrated by Task 6 (the clean
re-run). `npm run eval:loop` guards every loop-asset change (Tasks 1–4).

Dependency DAG: #30 (keystone) → {#31, #32, #33}; {#32,#33} → #34; {#30,#31,#32,#33} → #35.

## Task 1: conformance-gated per-template soften (P1 soften side) — #30

**Type:** feature
**Effort:** 3 context window(s)

### What to build
A non-converged scope softens only the crystallizations whose prescribed rules its actual DAG followed; rule-violating failures are attributed to composition (out of scope) and leave freshness untouched. Generalizes the OOM-only blind penalty into the automatic de-confounder.

### Acceptance criteria
- [ ] Conformed+failed → only that template's failure_count increments
- [ ] Violated+failed → freshness unchanged
- [ ] Trigger fires on any non-convergent terminal, not just context-OOM
- [ ] Unparseable rules → fail closed, never break scope close
- [ ] `npm run eval:loop` passes

### Files likely involved
[agent decides]

## Task 2: token-efficiency-graded conformant harden (P1 harden side) — #31

**Type:** feature
**Effort:** 2 context window(s)

### What to build
A converged scope credits only conformant crystallizations, graded by tokens/steps-to-converge — rewarding ingredients that let the simplest cooking win.

### Acceptance criteria
- [ ] Only conformant templates get success credit
- [ ] Token-efficient convergence → stronger credit
- [ ] Rule-violating convergence → no credit
- [ ] `npm run eval:loop` passes

### Files likely involved
[agent decides] — Blocked by #30 (reuses conformance comparator)

## Task 3: evidence-gated three-band metabolism (P2) — #32

**Type:** feature
**Effort:** 3 context window(s)

### What to build
Cron sweep retires proven-bad crystallizations (apoptosis), keeps proven-good, and surfaces the ambiguous middle to human triage with success-rate shown — alongside the existing 90-day atrophy. Reversible via logical-delete.

### Acceptance criteria
- [ ] Strong-bad → metabolized (superseded_by=id)
- [ ] Strong-good → kept
- [ ] Ambiguous → human triage with success-rate, never silent
- [ ] Atrophy + apoptosis coexist
- [ ] Human override can reinstate
- [ ] `npm run eval:loop` passes

### Files likely involved
[agent decides] — Blocked by #30

## Task 4: mid-flight escalation gate + memReflect quality/evidence return (P3) — #33

**Type:** feature
**Effort:** 3 context window(s)

### What to build
Beside memReflect: proceed silently only on confidently-good ingredients; otherwise emit a sparse verification report (shaky template's prescribed rules + success-rate); human approve/correct writes back clean attribution. memReflect now returns per-template quality_score + evidence.

### Acceptance criteria
- [ ] memReflect returns per-template quality_score + evidence volume
- [ ] Confidently-good plan → silent
- [ ] Shaky/unproven plan → report key steps + success-rate
- [ ] Human approve/correct → success/failure writeback
- [ ] No spurious escalation on every cold start
- [ ] `npm run eval:loop` passes

### Files likely involved
[agent decides] — Blocked by #30

## Task 5: human triage/edit surface (HITL) — #34

**Type:** feature
**Effort:** 3 context window(s)

### What to build
The write half of `/memory`: triage inbox + verification checkpoint where the human corrects drift via natural actions (accept/correct/approve/deny, never a typed number), as highest authority.

### Acceptance criteria
- [ ] Triage inbox shows ambiguous crystallizations + success-rate, keep/retire
- [ ] Approve/correct on a key step → success/failure writeback (no numeric entry)
- [ ] Explicit override is highest authority, can reinstate metabolized template
- [ ] No-action → degrades to automatic signal

### Files likely involved
[agent decides] — Blocked by #32, #33. HITL: design review first.

## Task 6: clean-DB re-run — falsification + constant calibration (HITL) — #35

**Type:** spike
**Effort:** 3 context window(s)

### What to build
Truncate all memory tiers, re-run the 18-step curve on the new substrate as the falsification test, and fit the 4 deferred constant classes from the data.

### Acceptance criteria
- [ ] Hermetic 18-step curve recorded as JSON (commit+model)
- [ ] 4 constant classes fit + written to config (P2 bands/n_min, P1 increments, P3 boundary, conformance tolerance)
- [ ] Re-run reaches optimum / honest null recorded
- [ ] `npm run eval:loop` converges, no collapse
- [ ] No causal story on polluted data

### Files likely involved
[agent decides] — Blocked by #30, #31, #32, #33 (NOT #34 — headless)
