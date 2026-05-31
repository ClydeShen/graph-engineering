# Graph-Native Agent Runtime

> Agent workflows are not portable. This is the runtime layer that fixes that.

---

## The Hard Part Is Not The Model

Every team building AI agents eventually discovers the same thing.

The hard part is not picking the right model.

The hard part is everything around the model:

- **Memory** — where does project knowledge live between runs?
- **Context** — how do you decide what the model sees, and what gets dropped?
- **Workflow** — how do you coordinate a sequence of decisions across multiple calls?
- **State** — when something fails halfway through, what do you recover from?
- **Tools** — what happens when the API changes, or you need to swap providers?

These problems are not unique to your project. They appear in every team building agents.

And every team solves them from scratch.

---

## The Real Problem: Workflows Are Not Portable

In traditional software, you build an application once, and it can run on different operating systems, different hardware, different infrastructure.

That portability exists because of a shared runtime contract:

```
OS  ←  runtime contract
 ↓
Application
```

Agent engineering has no equivalent:

```
Tool A
 ↓
Workflow A    ←  tightly coupled, cannot move
```

A workflow built for Claude Code cannot be reused in Codex.  
A memory system built around one vector database cannot migrate to another.  
A project's accumulated knowledge becomes trapped inside its tooling choices.

Change the tool — the workflow breaks.  
Change the model — the behavior shifts unpredictably.  
Start a new project — rebuild everything from scratch.

The result is predictable:

> Every team is rebuilding the same cognitive infrastructure. Again. And again. And again.

---

## What Is Missing

The missing layer is not another agent framework.

Most frameworks make the problem worse — they give you a higher-level API, but still couple your workflow to their specific abstractions, their specific tool integrations, their specific memory model.

What is missing is a **runtime layer** — a stable foundation that workflows, memory, and state can be built *on top of*, independent of which tools or models are executing beneath them.

The same way an OS decouples applications from hardware:

```
Runtime layer  ←  stable contract
      ↓
Workflow
      ↓
Tool / Model  ←  replaceable
```

When a tool changes, the workflow survives.  
When a model changes, the accumulated knowledge survives.  
When a project ends, the learned patterns transfer to the next one.

---

## What This Project Builds

This project implements that runtime layer.

The foundation is an **append-only event graph** stored in PostgreSQL. Every action, every decision, every failure is recorded as an immutable event. State is never overwritten — only extended.

This gives three things that agent systems usually lack:

**Portability** — Workflows are defined as patterns in the graph, not as code tied to a specific tool. Swap the tool; the graph stays intact.

**Persistence** — Knowledge accumulates across runs. When a task completes, the system extracts what worked and what failed, and injects that into the next similar task. The system gets smarter over time without anyone rewriting code.

**Auditability** — Every outcome traces back to the event that caused it. You can answer *why did the agent do this*, and you can reproduce any past state exactly.

---

## How It Works

A task starts by writing a root event to the graph. Workers — stateless executors — subscribe to event types on a shared bus, do one job, and write their result back as a new event. They have no direct access to each other; the graph is the only shared state.

```
plan_created
    │
    ├── task_spawned  "research competitors"
    │       │
    │       └── memory_updated  (result written)
    │
    ├── task_spawned  "extract pricing"
    │       │
    │       └── memory_updated  (result written)
    │
    └── scope_closed  (all paths converged)
            │
            └── templates extracted → reused in next similar task
```

When two Workers finish concurrently and conflict, the system resolves it automatically — the database constraint picks a winner, the loser is preserved as a `conflict_detected` event, and a resolver merges both outcomes. Nothing is lost. No exception propagates.

When the task closes, the system mines the graph for patterns and writes them to long-term memory. The next similar task starts with a pre-built skeleton. Workers skip the planning phase entirely.

---

## What Survives Tool Changes

Because the graph — not the tool — holds the state:

| If this changes | What survives |
|---|---|
| LLM provider | All accumulated knowledge, all workflow patterns |
| Tool / MCP server | All historical context, the task graph continues |
| Model version | Behavior may shift; the record of what happened does not |
| Project | Learned templates and failure patterns transfer |

---

## This Is Not

- Not another agent framework
- Not a replacement for Claude, Codex, or Cursor
- Not a vector database wrapper
- Not a workflow DSL

It is the layer *beneath* those things — the part that makes the rest of it portable.

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | TypeScript (Control Plane + Workers) |
| Event Bus | [iii-engine](https://github.com/iii-hq/iii) — Rust async event bus |
| Database | PostgreSQL — content-addressed event log, HNSW vector search, list partitioning |
| LLM Interface | OpenAI-compatible REST — works with OpenAI, Ollama, llama.cpp |

---

## Further Reading

| Document | Description |
|---|---|
| [`docs/RFC_v4.md`](docs/RFC_v4.md) | Full design rationale, architecture, and specification |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Component diagrams, sequence flows, data model |
| [`CONTEXT.md`](CONTEXT.md) | Domain glossary — precise definitions for all system terms |
| [`docs/ADR_v4.md`](docs/ADR_v4.md) | All 23 Architectural Decision Records |
