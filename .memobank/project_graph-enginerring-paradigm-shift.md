---
name: graph-enginerring-paradigm-shift
description: "Core paradigm reframe for graph-enginerring project — workflow discovery not graph runtime, context-as-projection, no workflow layer"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8f132545-c566-4c5b-b0d6-64f3d5924eef
---

The project's core identity is **workflow discovery from execution graphs**, not "graph runtime" or "memory system."

**Why:** Multiple README iterations revealed the original framing (blockchain, immutable event log, tamper-proof) was leading readers to misclassify the project as a memory system or LangGraph variant.

**Four paradigm rules (locked):**
1. **No Workflow Layer** — there is no workflow engine, DAG, or pipeline. What appears as a workflow is a statistical pattern emerging from execution history.
2. **Context as Projection** — `Graph (permanent state) → Context Window (per-call projection)`. Never `Context = State`.
3. **Workflow Emergence** — patterns discovered across superficially unrelated tasks (research, debug, design all share topology). Cross-domain topology is the highest-value form.
4. **LLM as Graph Navigator** — LLMs navigate accumulated traces; deviations feed back into the pattern library.

**Positioning:**
- Not a memory system (memory is one view of graph, not the product)
- Not LangGraph/Temporal (those execute defined workflows; this discovers them)
- Not event sourcing (purpose is pattern accumulation, not auditability/replay)

**Files updated in session 2026-06-01:**
- `README.md` — 6 iterations, final version leads with portability problem + paradigm
- `CLAUDE.md` — Paradigm section added, blockchain language removed
- `CONTEXT.md` — New §"系统范式" with 5 new terms: Workflow Emergence, Cross-Domain Topology Pattern, Context as Projection, Cognitive Trace, LLM as Graph Navigator
- `.harness/PROJECT.md` — Vision and Goals rewritten around workflow discovery

**How to apply:** Any future design decisions or documentation should be checked against these four rules. If a description implies a workflow layer exists, reframe it.

[[graph-enginerring-design-verification]]
