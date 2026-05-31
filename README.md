# Graph-Native Agent Runtime

> Memory, workflow, context, and state are not four separate problems. They are the same problem.

---

## Why Agent Systems Plateau

Current agent systems treat memory, workflow, context, and state as four separate engineering concerns.

Teams build a vector database for memory.  
A workflow engine for orchestration.  
A prompt strategy for context management.  
And hope that state stays consistent across all of it.

This separation feels natural until it breaks — and it always breaks.

**Memory cannot explain decisions** — it stores facts, not the reasoning that produced them. You can retrieve what the agent knew, but not why it concluded what it did.

**Workflow cannot survive tool changes** — it is coupled to the tools it was built with. Change the model, change the API, change the MCP server — the workflow breaks.

**Context becomes the system state** — when the prompt is the only thread connecting one LLM call to the next, the system has no stable ground. The model is simultaneously executor and memory. Everything must fit in the window. Anything that doesn't fit is forgotten.

**Knowledge becomes trapped** — projects accumulate expertise that cannot transfer anywhere else.

The industry's response has been to build bigger context windows. 100k tokens. 200k. 1 million.

That is not the answer. It is a more expensive version of the same fragile system.

---

## Context Is A Projection. Graph Is The State.

The core problem is a misidentification of what state is.

When a context window becomes the system state, the system reconstructs its entire understanding from scratch on every call. Everything depends on what fits in the prompt right now. Nothing persists beyond it.

The correct relationship is the reverse:

```
Graph              ←  state  (permanent, structured, queryable)
  ↓
Context Window     ←  projection  (computed per call, budget-constrained)
```

The graph holds everything. The context window is a view — assembled fresh each call from the parts of the graph that are causally relevant to the current moment.

This changes what is possible:

- The system never forgets. The graph accumulates indefinitely.
- Changing the model does not change what happened. The graph is model-independent.
- Any past state can be reconstructed exactly, without depending on a prompt that no longer exists.
- Context is no longer a liability to manage. It becomes a precise instrument.

---

## Memory, Workflow, Context, Knowledge Are The Same Thing

Once the graph is the state, a second insight follows naturally.

Memory, workflow, context, and knowledge are not separate systems that need to be integrated. They are different **views of the same graph**.

**Memory** — a query over past events in the graph.  
**Workflow** — the active path currently being extended through the graph.  
**Context** — a token-budget-constrained projection of the graph into the current LLM call.  
**Knowledge** — patterns extracted from how the graph has evolved across many runs.

Treating them as separate systems produces fragile results because they are not separate. Every integration point between them is a place where consistency can break, state can diverge, and the system can lose track of itself.

Building them on a single shared foundation eliminates those integration points entirely.

---

## Workflows Emerge. They Are Not Defined.

This is what separates this project from workflow engines.

LangGraph, Temporal, Prefect, Airflow — these tools help you define a workflow and execute it reliably. That is genuinely useful for predictable, well-understood processes.

But it is the wrong model for cognitive tasks.

A human cannot specify in advance how a complex research task, coding problem, or multi-step analysis should unfold. The right path depends on what the agent discovers along the way. A fixed workflow is not an agent — it is a script with an LLM attached.

The model this project works toward:

```
Agent executes
Graph records the full trace
Patterns are extracted from what worked
Workflows crystallize over time
Future agents start with that structure pre-built
```

When a task completes, the system mines its own execution history. Efficient paths — low conflict, correct outcomes — crystallize into reusable templates. Failed paths become warnings.

The next similar task starts with those templates already injected into the graph. Workers skip the planning phase. The skeleton is already there.

No human wrote that skeleton. The system grew it from its own experience.

---

## What This Project Builds

A runtime where memory, workflow, context, and state share one foundation: an **append-only event graph**.

Every action, every decision, every failure is recorded as an immutable event. State is never overwritten. The full history of every outcome is always traceable.

**Decentralized workers** subscribe to event types, do one job each, and write results back to the graph. There is no central orchestrator. The graph is the conductor.

**Conflict resolution is automatic.** When two workers race to the same node, the database picks a winner; the other is preserved as a `conflict_detected` event. A resolver merges both outcomes semantically. Nothing is lost.

**Context assembly is causal.** Before each LLM call, the system traces backwards through the graph's event lineage and assembles a precise projection within the token budget. No arbitrary truncation. No lossy summarization. Pure causal context.

**Memory emerges naturally.** Working, episodic, semantic, and procedural memory are all stored in the same database. They are not a separate product — they are query interfaces over the same graph that the workflow already produced.

---

## What Survives Tool Changes

Because the graph — not the tool — is the state:

| If this changes | What survives |
|---|---|
| LLM provider | All accumulated knowledge, all workflow patterns |
| Tool or external API | Historical context intact, task continues from last event |
| Model version | The complete record of what happened |
| Project ends | Learned templates and failure patterns transfer to the next project |

---

## This Is Not

**Not another memory system** — memory is one view of the graph, not the product. The product is the unified foundation beneath it.

**Not another workflow engine** — workflows emerge from execution history, not from definitions written in advance.

**Not LangGraph or Temporal** — those tools execute workflows you define. This system grows workflows from the cognitive traces agents leave behind.

**Not a replacement for Claude, Codex, or Cursor** — it is the runtime layer those systems should operate on top of.

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
