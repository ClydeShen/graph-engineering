---
name: project-memex-final-product-is-hermes-like-e2e
description: "Memex's long-term product target is a Hermes-agent-level end-to-end system built on MemexCore (user has stated this repeatedly) — near-term dashboard/TUI/connector work are stepping stones toward it, not competing designs"
metadata:
  type: project
  originSessionId: 34d8dadb-193c-4b05-9349-b6cfc1eb25a9
---

The user has stated multiple times — most explicitly on 2026-06-08 during a `/fuller` architecture-spike session — that **Hermes-agent is the reference target for Memex's final product form**: "Hermes 是我们最终产品实现的目标，也就是基于 MemexCore 造一个端到端系统。" This is a **vision-level fact**, not a near-term design decision — and conflating the two timescales is what was causing repeated confusion in design discussions (see below).

**The structural split that resolves the confusion:**
- **Now** (current phase scope): reuse already-planned pieces — the dashboard's chat interface (AI Elements–based), the Phase 6 graph-inspection TUI, and the Pi/Codex/Claude-Code connector pattern (`packages/cli/src/connect/`). No new component gets built for this.
- **Later** (vision/roadmap level): these pieces are **down payments** toward an eventual end-to-end product — tentatively named **MemexShell** — that sits on top of **MemexCore** (the existing graph engine / ledger / Worker runtime) and matches Hermes's interaction model and product shape. MemexCore already exists; MemexShell does not yet, and building it is explicitly understood as future, larger-scope work — not something to retrofit into the current console/dashboard spike.

**Why this matters:** Without this split written down, "should we build a Hermes-like TUI/shell now?" kept resurfacing as an open architectural question — each time requiring a fresh investigation to determine whether it was scope-creep (it would have been, for the *current* phase) or a legitimate target (it is, for the *eventual* product). The existing comparison artifact `.harness/analysis/hermes-graph-comparison.md` is framed as "extract useful Hermes *features* into Memex's existing layers" (Category 1: directly integrable / Category 2: additive extensions / "what does NOT transfer") — a feature-extraction lens, not a "build a structurally parallel product" lens. That framing is correct **for the current phase**; it should not be read as contradicting the longer-term MemexShell vision — the two operate at different time horizons and the comparison doc's scope is appropriately narrower.

**How to apply:** When any future design/plan touches "how does the user/external agent interact with Memex" (dashboard pages, TUI, connectors, onboarding flows), ask first: *"is this near-term scope (reuse/extend existing planned pieces) or are we now building toward MemexShell itself (the eventual end-to-end product)?"* If the former, follow [[project_console_unifies_to_graph_projection]]'s reuse-first discipline. If genuinely the latter — i.e., the user is signaling it's time to start building the end-to-end shell — that is a phase-level decision warranting its own roadmap entry and scoping discussion, not something to fold quietly into a console/dashboard spike. The note in `.harness/ROADMAP.md`'s new "北极星" section makes this anchor durable across sessions.
