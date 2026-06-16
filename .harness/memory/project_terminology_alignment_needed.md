---
name: project_terminology_alignment_needed
description: User wants a dedicated pass to align Memex/MemexCore/MemexShell terminology — flagged repeated miss-understandings (2026-06-08)
metadata: 
  node_type: memory
  type: project
  originSessionId: 0b497910-9c7a-41d8-b338-f1be4126fac2
---

User explicitly asked (2026-06-08, mid-session) to "align专有词汇，概念" — align the
project's proprietary vocabulary/concepts — because they noticed miss-understandings
during this conversation's discussion.

**Why:** This is the second session in a row where conflations surfaced mid-discussion:
- 2026-06-07 (`/fuller` pass, see `.harness/state.json` position.stopped_at): three
  conflations found — (1) "Memex has a default TUI from Pi SDK" was inverted (Pi
  Terminal is an external peer agent Memex connects to, not Memex's own UI); (2) "BFF
  API" turned out to just mean the existing Gateway; (3) "Codex/Claude Code connect via
  MCP as A2A identity, registered as Workers" mixed three orthogonal ADR-42 dimensions
  (protocol=MCP, identity='LLM Agent', category≠Worker/A2A).
- 2026-06-08 (this session): user's onboarding-TUI idea initially conflated the
  user-facing MemexShell config layer with the worker-injected `LLMProvider` (ADR 22 —
  workers never hold credentials, injected via `iii-config.yaml`). Resolved — recorded
  as a MemexShell candidate in `.harness/ROADMAP.md` 北极星, not folded into Phase 5.

Each conflation costs a discussion cycle to untangle. The user wants this addressed
proactively rather than re-discovered each session.

**How to apply:** Before/during any design discussion touching Memex vocabulary
(Trail/Association/Entity/Crystallization, MemexCore vs MemexShell, LLMProvider vs
onboarding/config layers, MCP/A2A/Worker/iii identity dimensions), cross-check against
CLAUDE.md "Key Domain Terms", ADRs (esp. 22, 42), and [[project_memex_final_product_is_hermes_like_e2e]]
first — don't let the user re-explain distinctions that are already documented.
Treat "run a structured terminology/concept alignment session" as a standing
high-priority next-step candidate (e.g. via `grill-with-docs` or a dedicated glossary
review) — the user raised it explicitly and it should not get silently dropped.
