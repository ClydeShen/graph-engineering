# Memex — Product Definition

- **Status**: Proposed (plain-language synthesis of the three `/fuller` sessions; nothing new decided here)
- **Date**: 2026-06-25
- **Companion**: `docs/LEARNING-ENGINE-REFRAME.md` (the structural design + research basis)

This page answers four questions in plain language: what it is, what it does, what
changes for the user, and how confident we are. It is the one page to fix first for an
outside audience or for ourselves.

---

## 1. Positioning — it is the *ground* under agents, not another agent

> **Memex is a shared runtime environment + independent-verification substrate that lets
> any coding agent (Claude Code / Codex / the owned MemexTerminal) turn the mistakes it
> makes into executable skills it avoids next time.**

Where it sits:

- **Claude Code / Codex** = the *body* (writes code, runs its own loop).
- **Mem0 / Letta** = *memory* (RAG for agents) — the **rejected altitude**; a blackboard
  empirically beats RAG and master-slave orchestration by 13–57% end-to-end.
- **Memex** = the *blackboard environment* where generator, an **independent verifier**,
  planner, and workers each run their own loop and coordinate indirectly through traces
  (stigmergy). The brain stays in the agents; Memex is the world they act in and learn
  from.

## 2. Core function — one irreducible loop

The product does exactly one thing:

> A real task is attempted → traces (including failures) are written to the graph →
> **only verified** successes crystallize into an **executable skill** → next time a
> meta-reflex flags "there's a trap / a ready solution here" → the agent pulls it and
> **avoids the known-failed path**. Across many tasks this compounds into **error
> transfer** — the system gets faster at avoiding mistakes it has already made.

Five mechanisms (mostly already built): shared graph (Trail Mesh) · verification-gated
skill crystallization · retrieval/escalation meta-reflexes · an independent verifier
holding tooling the generator lacks · environment physics (convergence / OCC / liveness).

## 3. With vs without — a goldfish vs an agent that learns

| | Without Memex | With Memex (target state) |
|---|---|---|
| Across sessions | cold start every time; the same project-specific gotcha is re-hit | failures become durable, reusable skills; attempt N avoids attempt 1's mistake |
| Verification | writer == verifier self-grading; **reinforces self-consistent errors** | an independent verifier (asymmetric tooling + history) breaks the self-loop |
| Capability curve | flat — failures don't compound into competence | competence compounds on *your* tasks / repo with use |

Sharpest framing: the difference is **"an agent that forgets every session" vs "an agent
that turns its mistakes into skills."** That is the whole bet.

**Honest caveat:** the right-hand column is the *target / hypothesis*, not yet proven on
real tasks. Prior experiments showed the loop *can* learn (a 26→24 step-change) but also
that a **naive self-loop hits a ~0.5 ceiling**. This reframe (independent verifier +
human oracle + executable skills) is a credible escape aimed squarely at that ceiling —
but the escape is **not yet validated**.

## 4. Confidence — decomposed, not a single number

| Sub-claim | Confidence | Basis |
|---|---|---|
| **Can be built** (engineering) | **High (~80%+)** | Substrate largely already built and tested (graph / event-sourcing / OCC / crystallization / recall / MemexTerminal / federation / Experiment A verifier). What remains is wiring, not invention. |
| **Direction is right** (paradigm) | **High** | Four dimensions agree: user judgment (3 sessions) + reasoning + existing code + 2026 research (loop engineering; blackboard beats RAG + master-slave; verification asymmetry). |
| **Actually works on the owned proving ground** (MemexTerminal error-transfer, human oracle) | **Medium (~50–60%)** | The real unknown. The prior arc concluded a self-loop can't beat baseline; the reframe targets that root cause but remains a hypothesis. |
| **Wins as a product serving opaque external agents** | **Lower / undetermined** | Depends on (1) the proving ground succeeding first, (2) integration surfaces we don't control (MCP / hooks), (3) adoption, (4) a moat that is a *combination* and thus replicable. |

**Honest conclusion:** confidence is **high that the direction is right and the system is
buildable**; what is genuinely open is **whether it actually works on real tasks**.

That open question is also the design's smartest move: the biggest uncertainty (efficacy)
is **isolated into a cheap, fully-observable proving ground** (MemexTerminal running the
error-transfer metric) that can **falsify it before** any large investment in serving
external agents. If the proving ground shows transfer, confidence jumps; if not, little
was spent and the answer arrives early.

> So the right answer to "how confident are we" is **not a percentage — it is an action:
> run the proving ground first.** Until it reports, any "will it succeed" number
> (including the ~50–60% above) is an estimate from priors, not a measurement.

---

## The one decisive next step

Run the **MemexTerminal error-transfer proving ground** (§7 of the reframe): a real-task
suite where a class of error recurs; measure whether attempt N avoids attempt 1's
mistake, with the human-primary + test-fallback oracle. Everything else — serving Claude
Code / Codex, the meta-reflex training seam, liveness tuning — waits behind that result.
