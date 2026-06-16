---
name: project_planning_harness_drift
description: RESOLVED 2026-06-12 — .planning demoted to progress ledger; .harness/ROADMAP.md canonical for Phase 7+
metadata: 
  node_type: memory
  type: project
  originSessionId: 922de504-97c0-43e9-a4cd-778b42f523a6
---

**RESOLVED** (commit 6d6f1763, 2026-06-12): `.planning/ROADMAP.md` now carries only the
Progress table (all 16 phases) + Phase 1–6 details, with an explicit banner deferring to
`.harness/ROADMAP.md` as canonical for Phase 7+. `.planning/STATE.md` rewritten to match
reality (now 16/16 complete). The structural fix that prevents recurrence: phase details for
7+ are never duplicated into `.planning/` — single source, no double-write.

`.planning/phases/NN-*/` dirs keep PHASE-SPEC.md only (no PLAN/SUMMARY) for phases executed
outside the GSD loop — this is intentional, not missing data.

**Why:** GSD tooling (`gsd-sdk roadmap.analyze`, `init.progress`) reads `.planning/`; stale
data mis-routes `/gsd:*` commands.

**How to apply:** when updating progress, touch `.planning/ROADMAP.md` Progress table +
`.planning/STATE.md` frontmatter in the same commit as `.harness/state.json`.

[[project-phase15-16-complete]]
