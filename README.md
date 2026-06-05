# Graph-Native Agent Runtime

> A system where workflows are not designed or executed, but discovered as emergent structures from a shared execution graph.

---

## The Problem

Most agent systems require workflows to be explicitly designed, which makes them brittle and hard to reuse.

When the model changes, the workflow breaks.  
When the tool changes, the workflow breaks.  
When a new project starts, the workflow is rebuilt from scratch.

The deeper issue is not the brittleness of any individual workflow. It is that the entire model is wrong.

Designing workflows in advance assumes you know the right path before you start. For simple, well-understood tasks, that is fine. For complex cognitive work — research, debugging, design, planning, analysis — the right path depends on what you discover along the way.

Pre-defined workflows are not agent workflows. They are scripts with LLMs attached.

---

## The Missing Abstraction

Current agent systems treat memory, workflow, context, and state as separate engineering concerns.

Teams build a vector database for memory.  
A workflow engine for orchestration.  
A prompt strategy for context.  
And hope state stays consistent across all of it.

The separation creates four failure modes that compound each other:

- **Memory cannot explain decisions** — it stores facts, not the reasoning that produced them
- **Workflow cannot survive tool changes** — it is coupled to the tools it was built with
- **Context becomes the system state** — when the prompt is the only thread between calls, nothing persists beyond the current window
- **Knowledge becomes trapped** — expertise accumulated by one project cannot transfer to another

The industry's response has been to build bigger context windows. That is a more expensive version of the same fragile system.

---

## Context Is A Projection. Graph Is The State.

The root of the context problem is a misidentification.

When a context window becomes the system state, the system reconstructs its entire understanding from scratch on every call. Everything depends on what fits in the prompt right now. Anything that doesn't fit is forgotten.

The correct relationship:

```
Graph              ←  state  (permanent, structured, always queryable)
  ↓
Context Window     ←  projection  (assembled per call, within token budget)
```

The graph holds everything. The context window is a view — computed fresh from the parts of the graph causally relevant to the current call.

This means the system never forgets, changing the model does not change what happened, and any past state can be reconstructed exactly — without depending on a prompt that no longer exists.

---

## Memory, Workflow, Context, Knowledge Are Views Of The Same Graph

Once the graph is the state, a second insight follows.

Memory, workflow, context, and knowledge are not separate systems. They are different **views of the same graph**:

- **Memory** — a query over past events
- **Workflow** — the active path currently being extended
- **Context** — a token-budget projection of causal lineage
- **Knowledge** — patterns extracted from how the graph has evolved

Building them as separate systems produces fragile results because they share the same underlying structure. Every integration point between them is a place where consistency can break and state can diverge.

A shared graph eliminates those integration points entirely.

---

## There Is No Workflow Layer

This system does not contain a workflow engine.

There is no workflow definition language.  
There are no DAGs to design.  
There are no pipelines to author.

What appears as a "workflow" is not a system component. It is a statistical pattern that emerges from execution history in the graph. The workflow was never written by anyone. It surfaced from accumulated execution.

---

## Workflows Are Not Written. They Are Discovered.

The most powerful property of recording every execution in a shared graph is not that individual workflows improve over time. It is that the system can discover **recurring structures across workflows that appear completely unrelated to humans**.

Consider:

```
Research competitors        Debug production incident
      ↓                              ↓
Gather evidence             Gather evidence
      ↓                              ↓
Form hypotheses             Form hypotheses
      ↓                              ↓
Validate                    Validate
      ↓                              ↓
Converge on answer          Converge on root cause
```

To a human, these are different kinds of work. To the graph, they share the same topology.

The same underlying structure likely appears in designing an API, writing a PRD, investigating a security incident, and planning a migration. Across many executions, the same phases — exploration, hypothesis formation, validation, convergence — surface repeatedly in entirely different domains.

Because every task is recorded in the same graph, those structures become visible across task boundaries.

The goal is not to optimize known workflows.  
**The goal is to surface workflows that were never explicitly designed** — cross-domain structures that are invisible at the level of individual tasks, discoverable only when execution traces accumulate at sufficient scale.

---

## What LLMs Are Actually Doing

LLMs in this system are not executing workflows.

They are **navigating a graph of accumulated execution traces**.

The system does not instruct them on how to solve tasks. It provides them with structures that have already proven useful in similar contexts — and then leaves them free to follow, adapt, or diverge from those structures.

When an LLM deviates from a known pattern and finds a better path, that path becomes part of the accumulated record. The discovered pattern updates. Future runs inherit it.

This means the system improves not by being programmed, but by being used. The LLM's own judgment — expressed as graph evolution — is what the system learns from.

---

## What This Project Builds

A runtime where execution is the input and workflow discovery is the output.

**An append-only event graph.** Every action, decision, and failure is recorded as an immutable event. State is never overwritten. The full history of every outcome is always traceable.

**Decentralized workers.** Stateless executors subscribe to event types, do one job, and write results back to the graph. No central orchestrator. The graph conducts; workers execute.

**Automatic conflict resolution.** When two workers race to the same node, the database picks a winner; the other is preserved and a resolver merges both outcomes semantically. Nothing is lost.

**Causal context assembly.** Before each LLM call, the system traces backwards through the graph's event lineage and assembles a precise projection within the token budget. Pure causal context — no arbitrary truncation.

**Emergent memory.** Working, episodic, semantic, and procedural memory are all stored in the same database — query interfaces over the graph the workflow already produced, not a separate product.

---

## What Survives Tool Changes

Because the graph — not the tool — is the state:

| If this changes | What survives |
|---|---|
| LLM provider | All accumulated knowledge, all discovered patterns |
| Tool or external API | Historical context intact, task continues from last event |
| Model version | The complete record of what happened |
| Project ends | Discovered patterns and failure traces transfer to the next project |

---

## Common Misconceptions

**"This is a memory system."**  
Memory is one view of the graph. It is not the product. A memory system stores what you know. This system records how you arrived at what you know — and surfaces structural patterns from that record.

**"This is workflow optimization, like LangGraph with learning."**  
LangGraph executes workflows you define. This system has no workflow layer. Patterns emerge from execution; they are not derived from existing workflows.

**"This is like Temporal or Durable Execution."**  
Temporal ensures that defined workflows run to completion, reliably. This system does not define workflows. It discovers them. The scope is different: reliability of execution vs. emergence of structure.

**"This is event sourcing."**  
Event sourcing is a storage pattern. This system uses append-only events as storage, but the purpose is not auditability or replay. The purpose is to accumulate a graph dense enough that cross-task cognitive patterns become visible.

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | TypeScript (Control Plane + Workers) |
| Event Bus | [iii-engine](https://github.com/iii-hq/iii) — Rust async event bus |
| Database | PostgreSQL — append-only event log, HNSW vector search, list partitioning |
| LLM Interface | OpenAI-compatible REST — works with OpenAI, Ollama, llama.cpp |

---

## Further Reading

| Document | Description |
|---|---|
| [`docs/RFC_v4.md`](docs/RFC_v4.md) | Full design rationale, architecture, and specification |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Component diagrams, sequence flows, data model |
| [`CONTEXT.md`](CONTEXT.md) | Domain glossary — precise definitions for all system terms |
| [`docs/ADR_v4.md`](docs/ADR_v4.md) | Architectural Decision Records ADR 01–42 (core) + supplements in `docs/adr/` |
