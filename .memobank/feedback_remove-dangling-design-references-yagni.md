---
name: remove-dangling-design-references-yagni
description: "When a spec references a decision/ADR number that was never actually made (a ghost reference), apply YAGNI/Occam's razor and delete the reference rather than retrofitting a definition — confirmed 2026-06-07"
metadata:
  node_type: memory
  type: feedback
  originSessionId: ade24479-a2bb-448e-9e6e-71ebeb2abba7
---

When cross-referencing a spec doc against the actual ADRs/plans and finding a forward-reference to a decision that doesn't exist (e.g. `docs/UI-SPEC.md` cited "特权注入面板（需 D-11 + POST 写操作）" but no ADR or plan anywhere defines "D-11" — grep across `docs/` returned exactly one hit, the citing line itself), the user's instinct is: **delete the dangling reference outright, don't try to retroactively define what it might have meant**.

**Why:** The user invoked YAGNI + Occam's Razor explicitly: "如果是个悬空的设计，就先去掉吧，移除这部分对前后整体design没有任何影响，就去掉" (if it's a dangling design, remove it — removing it has zero impact on the surrounding design). This is the same posture as [[reanchor-on-original-design-when-drifted]] (don't keep refining a thread that rests on a false premise — go back to source) but applied at the granularity of a single spec line rather than a whole design thread: a reference to an undefined decision is itself evidence the feature was never properly designed, so removing it is strictly safe (nothing real depends on a thing that was never defined).

**How to apply:** When auditing specs/ADRs in this project and a citation (`D-N`, `ADR NN`, a worker name, an event type) doesn't resolve to anything in `docs/adr/`, `.harness/phases/*/PLAN.md`, or the codebase — don't propose Option B ("maybe it means X, let's define it now"). Default to surfacing it as a dangling reference and recommending deletion, scoped surgically to exactly the lines that cite the ghost decision (in this instance: one bullet in the "暂不实现 (Phase 4+)" list, plus the inline mention in the read-only-principle line one paragraph above — both removed, nothing else touched). The user confirmed this is the right call without hesitation.
