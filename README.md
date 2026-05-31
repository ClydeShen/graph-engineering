# Graph-Native Agent Runtime

> Workflows are not designed. They emerge from execution graphs.

**Not a memory system. Not a workflow engine. A system for discovering workflows from execution.**

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

## Workflows Are Not Written. They Are Discovered.

This is the claim that separates this project from all existing workflow tools.

The most powerful property of recording every execution in a shared graph is not that individual workflows improve over time. It is that the system can **discover recurring structures across workflows that appear completely unrelated to humans**.

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

The same is likely true of designing an API, writing a PRD, investigating a security incident, and planning a migration. Across many executions, the same phases — exploration, hypothesis, validation, convergence — surface repeatedly in different domains.

Because every task is recorded in the same graph, those structures become visible across task boundaries. The system can surface cognitive patterns that no human designer would have thought to encode.

The result is not workflow optimization. It is **workflow discovery**.

---

## Patterns Influence, Not Constrain

When a discovered pattern is applied to a new task, it does not lock the agent into a fixed execution path.

The graph suggests likely next steps based on what has worked before. The agent remains free to diverge — and if it finds a better path, that path becomes part of the accumulated record too.

This creates a different kind of reuse than template injection:

```
Pattern
  ↓
Suggested structure    ←  agent can follow or deviate
  ↓
Execution
  ↓
New trace added to graph
  ↓
Pattern updated
```

The system is not a workflow engine that you configure once. It is a structure that continuously learns what good execution looks like — across task types, projects, and teams — and uses that knowledge to make every future run start smarter.

LLMs today are capable enough to self-organize around discovered patterns. They do not need a human to hand-code the right workflow for each domain. They need a system that can surface the structures that emerge from accumulated execution.

---

## What This Project Builds

A runtime where execution is the input and workflow discovery is the output.

**An append-only event graph.** Every action, decision, and failure is recorded as an immutable event. State is never overwritten. The full history of every outcome is always traceable.

**Decentralized workers.** Stateless executors subscribe to event types, do one job, and write results back to the graph. No central orchestrator. The graph conducts; workers execute.

**Automatic conflict resolution.** When two workers race to the same node, the database picks a winner; the other is preserved and a resolver merges both outcomes semantically. Nothing is lost.

**Causal context assembly.** Before each LLM call, the system traces backwards through the graph's event lineage and assembles a precise projection within the token budget. Pure causal context — no arbitrary truncation.

**Emergent memory.** Working, episodic, semantic, and procedural memory are all stored in the same database. They are not a separate product — they are query interfaces over the graph the workflow already produced.

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

## This Is Not

**Not a memory system** — memory is one view of the graph, not the product

**Not a workflow engine** — workflows emerge from execution history, not from definitions written in advance

**Not LangGraph or Temporal** — those tools execute workflows you define; this system discovers workflows from the cognitive traces agents leave behind

**Not a replacement for Claude, Codex, or Cursor** — it is the runtime layer those systems should operate on top of

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
| [`docs/ADR_v4.md`](docs/ADR_v4.md) | All 23 Architectural Decision Records |
