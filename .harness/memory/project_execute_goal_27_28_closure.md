---
name: project_execute_goal_27_28_closure
description: /execute-goal 2026-06-15 — #27/#28 reconciled as mostly-already-shipped; only real gap #27 AC3 node art built + verified; both issues all-AC green
metadata:
  type: project
---

/execute-goal "完成所有已讨论但未开工的开发" 2026-06-15. Reconciliation finding:
#27/#28 were ALREADY mostly shipped in commit 63a4b7f4 (verified per-AC against
code, not re-implemented). on-hold #24/#25/#26 are frozen by prior decision →
explicitly OUT of scope (starting them contradicts established decisions).

Only genuine "未开工" gap = **#27 AC3 Now node art**. Built it (commit 7807b9e5):
decision = 3D-native vocabulary (icosahedron galaxy / octahedron task + emissive/
opacity by status + active-only pulse), NOT flat 2D Kenney/AI-Town sprites —
design doc line 124 sanctions 3D-equivalent; sprite path was always a future seam.
Executed via ui-ux-pro-max. graph3d.ts makeNodeObject + UniverseCanvas.

Two build/test fixes surfaced & fixed: (1) @types/three devDep (three was a runtime
dep w/o types; root tsc tolerated implicit-any, Next build did not). (2) vitest.config
'@/' alias (keyed '@/' to not shadow @graph/*) — fixed a pre-existing silent load
failure in forest-universe.test.ts.

LLM no longer blocked: real chat through nvidia replied correctly (~3.2s) → #27 AC4
real-LLM half done; browser-confirmed the node art renders live.

Gates all green: 726/726 DB tests · root typecheck · next build · canonical E2E
journey 11/11. Both #27 and #28 now all-AC satisfied, synced on GitHub, recommended
for human-review close (status:needs-review; only non-code item = §6.5 write-path
security review for #27, a process gate). Commit 7807b9e5 UNPUSHED. Supersedes the
"BLOCKED on real LLM" residual in [[project_phase21_22_remaining_complete]].
