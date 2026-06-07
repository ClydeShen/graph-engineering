---
name: reanchor-on-original-design-when-drifted
description: "When a multi-session design discussion feels off, re-derive from original ADRs/vision rather than keep refining the drifted design — confirmed effective 2026-06-07"
metadata:
  node_type: memory
  type: feedback
  originSessionId: dfe88d71-1f58-4f26-9b91-8585b9e49962
---

When the user senses a design discussion has drifted ("我认为这几个最新讨论的话题有些over-design了"), the effective move is to **stop refining the in-flight design and instead re-map the original architecture/vision from primary sources** (ADRs, CONTEXT.md, PROJECT.md vision section) — then diagnose the drift by comparing the proposed design's *posture* against the original design's *posture* on the same concern, not just its details.

**Why:** In the 2026-06-07 session, a token-budget-prediction design (built up over several /grill-me rounds) turned out to rest on a false premise — it imported a pain point from an external system (manual `/compact` in LLM CLIs) that doesn't map onto this system's architecture, which had already solved the underlying concern with a completely different, deliberately invisible mechanism (ADR 30's Zero-LLM discarder + ADR 13's rare escalation chain). Reading the original ADRs directly — rather than continuing to interrogate the drifted design's open questions (e.g., "Q10: how to phrase the prediction") — surfaced this in one pass. The user confirmed this framing immediately ("没错，就是这个意思").

**How to apply:** In this project specifically — when a design thread spans multiple sessions and the user expresses unease about its direction, don't keep drilling into the thread's own open questions. Pull the relevant ADRs / CONTEXT.md / PROJECT.md vision and ask: "does the *original* design already have an answer to this concern, and if so, does the new proposal's posture match or contradict it?" That comparison is usually the highest-leverage move — it can dissolve many downstream sub-questions at once (here it collapsed Q1-Q10 entirely). See [[token-budget-design-concluded]] for the concrete outcome.
