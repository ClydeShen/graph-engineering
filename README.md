# Graph-Native Agent Runtime

> Stop rebuilding agent infrastructure. Build on a graph that thinks, remembers, and evolves.

---

## The Problem Every Team Hits

Whether you are building a coding agent, a research pipeline, a knowledge assistant, or an enterprise automation — your team eventually builds the same things:

```
memory/          ← user preferences, project context, decisions
context/         ← summarization, retrieval, injection
workflow/        ← plan → execute → review → fix
adapters/        ← Claude, Codex, MCP, GitHub, Slack ...
```

Different names. Same architecture. Built from scratch. Again.

This is not a productivity problem. It is a missing abstraction problem.

---

## Seven Pain Points

### 1. Tool Lock-In

Most workflows are built *around* tools, not *above* them:

```
Tool → Workflow        ← what most teams build
Intent → Execution → Tool   ← what they should build
```

When Claude changes its API, the MCP spec shifts, or pricing breaks your budget — the workflow breaks with it. The entire control flow is coupled to a tool that you don't control.

### 2. Workflows Cannot Be Reused

A coding workflow — read, analyze, plan, modify — cannot become a research workflow without rewriting prompts, tools, and orchestration logic. Every project ends up creating another workflow engine instead of reusing one.

### 3. Memory Is Treated As Storage

Most systems think memory means a vector database or an embedding store. But memory is not storage. Memory is:

- **Identity** — is this the same thing we saw before?
- **History** — how did we get here?
- **Evolution** — has this fact changed?
- **Contradiction** — does this conflict with what we know?

Without those properties, memory is just a large, searchable cache. It cannot tell you whether a fact has been superseded, how a conclusion was reached, or whether two pieces of knowledge contradict each other.

### 4. Context Window Becomes System State

Most agent frameworks encode state inside the LLM prompt:

```
Conversation history + injected context + prompt engineering = system state
```

This is expensive, fragile, model-dependent, and impossible to replay accurately. Change the model and the behavior changes. The entire "state" is hidden inside tokens you can't inspect or audit.

### 5. No Unified Representation

Memory, workflow, tasks, agents, tools, and knowledge are implemented as separate systems — vector databases, workflow engines, task queues, memory layers, agent runtimes — all with their own representations of the same underlying concepts: dependencies, state transitions, ownership, history, relationships.

The result is duplicated logic everywhere, with no shared language between systems.

### 6. No Replayability

Most systems cannot answer:

- *Why did the agent make this decision?*
- *What was the state of the system at 2pm yesterday?*
- *Can we reproduce this exact outcome?*

Because prompts, context, memory, and tool outputs all changed — and nothing was recorded immutably. There is no audit trail.

### 7. Agents Are Service-Centric

Most systems are built as `Agent → Tool → Result`. Control flow belongs to services. This creates hidden state, hidden decisions, poor observability, and components that are nearly impossible to swap out.

---

## The Fundamental Observation

Memory, workflow, agents, tools, tasks, and knowledge are not separate concerns.

**They are all different views of the same underlying structure.**

Every one of them is an entity that changes over time, has a history, participates in relationships, and needs to be traced back to the intent that caused it.

---

## The Solution: A Graph Runtime

Instead of building another agent framework, this project builds a **graph runtime** — the missing layer that agent frameworks should sit on top of.

The design is borrowed from **blockchain ledger philosophy**:

- Every action is an **immutable event** appended to a shared graph.
- Every event has a cryptographic hash of its content and a pointer to its predecessor — forming an unbreakable chain.
- Nothing is ever overwritten. History is permanent.
- The graph is the single source of truth. Tools, models, and services are replaceable.

Think of it as **Git for agent cognition**: every decision is a commit with a hash, a parent, and a payload. You can trace any outcome back to the intent that created it.

```
Intent
  │
  ▼  plan_created (genesis — no predecessor)
  │
  ▼  task_spawned  hash: 0x1a2b...  ← predecessor: genesis
  │
  ▼  memory_updated  hash: 0x3c4d...  ← predecessor: 0x1a2b
  │
  ▼  scope_closed  hash: 0x5e6f...  ← predecessor: 0x3c4d
```

**Workers** — stateless executors — subscribe to events on a shared bus, do one job, and write results back to the graph. They have only `SELECT` and `INSERT` access. They cannot mutate history. They are destroyed after each use.

When two Workers conflict — both writing to the same node simultaneously — the database constraint picks a winner atomically. The loser is not discarded; it is reframed as a `conflict_detected` event. A dedicated resolver merges both versions semantically and writes a reconciled node. **No work is lost. No exception propagates.**

When a task completes, the system mines the graph for patterns: efficient paths become reusable templates; failed paths become anti-patterns to avoid. The next similar task starts with a pre-built skeleton. **No human writes the workflow. The system evolves it.**

---

## A Concrete Example

You ask the system: *"Research our top 5 competitors and draft a positioning report."*

**1 — Scope is born**

A root event is written. This is the genesis block for this task.

```
plan_created
  hash: 0xabc123
  predecessor: null
  payload: { intent: "Research competitors and draft positioning report" }
```

**2 — Workers fan out**

A planning Worker reads the root event and breaks the task into subtasks, each written as a new event:

```
task_spawned  "Find top 5 competitors"      predecessor: 0xabc123
task_spawned  "Extract pricing pages"        predecessor: 0xabc123
task_spawned  "Summarize differentiators"    predecessor: 0xabc123
```

**3 — Two Workers race**

Two Workers finish at the same moment and both try to advance the same node. The database is the referee:

```
Worker A → memory_updated  (wins — chain advances)
Worker B → conflict_detected  (demoted — predecessor forced to point at Worker A's result)
```

A `ConflictResolverWorker` wakes up, reads both sides, merges them semantically, and writes a single reconciled result. The conflict becomes part of the permanent record — evidence of what happened and how it was resolved.

**4 — The Scope closes and learns**

A Watchdog monitors graph topology. When all branches converge, it writes `scope_closed`. A `TemplateProposalWorker` then:

- Extracts the lowest-conflict paths as **reusable templates**
- Archives failed branches as **anti-patterns to avoid next time**
- Writes summaries to long-term memory

The next time someone asks a similar question, the system injects a pre-built skeleton into the new task's graph. Workers start working immediately rather than planning from scratch.

---

## Core Concepts

| Concept | What it means |
|---|---|
| **Execution Graph** | The single source of truth. An append-only event log in PostgreSQL — everything ever decided or done lives here permanently. |
| **Entity / Version** | An entity is a stable logical object (UUID). A Version is one immutable snapshot of it, identified by a SHA-256 hash of its content and full lineage. |
| **Scope** | A container for one top-level task, spanning multiple AI context windows. Like a process group in an OS. |
| **Worker** | A stateless executor: subscribes to one event type, does one job, writes the result back to the graph. Destroyed after use. |
| **Topological Horizon** | The precise graph slice fed to the LLM — traced backwards along predecessor hashes, trimmed to fit the token budget. Pure causal lineage, no lossy summarization. |
| **OCC** | Optimistic Concurrency Control — concurrent Workers race; the database constraint picks the winner atomically; the loser is reframed as a `conflict_detected` event, not discarded. |

---

## Architecture Overview

```
User Intent
    │
    ▼
┌────────────────────────────────────────────────────┐
│  Control Plane  (TypeScript)                        │
│  • Creates Scope (DDL: partition + vector index)    │
│  • Bridges DB notifications → event bus             │
│  • Runs Convergence Watchdog                        │
└──────────────────────┬─────────────────────────────┘
                       │
               ┌───────▼────────┐
               │  iii-engine    │  ← pre-installed Rust binary
               │  Routes events │    WebSocket to matching Workers
               └───────┬────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
     [Worker A]   [Worker B]   [ConflictResolverWorker]
     SELECT only  SELECT only   reads forks, merges, writes v_merged
          │            │            │
          └────────────┴────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────┐
│  PostgreSQL  —  Single Source of Truth              │
│                                                     │
│  execution_event_log   ← the living graph           │
│  episodic_memory       ← "what happened last time"  │
│  semantic_memory       ← "what we know to be true"  │
│  procedural_memory     ← "how to do it well"        │
└────────────────────────────────────────────────────┘
```

---

## Why Three Properties Make This Work

**Tamper-proof state** — Each node's hash is computed from its content plus its parent's hash. You cannot change a past event without invalidating every node that follows. The entire chain is always verifiable.

**Decentralized control flow** — There is no central orchestrator. Workers subscribe to events and react independently. The graph conducts; Workers execute. Swap any Worker, any tool, any model — the graph stays intact.

**Self-evolving workflows** — After every completed task, the system mines its own execution history. Efficient paths become templates; failed paths become warnings. The system gets smarter every run without anyone writing new code.

---

## What This Is Not

This is not another agent framework.  
This is not a replacement for Claude, Codex, or Cursor.  
This is not an opinionated workflow engine.

It is the **runtime layer** that those systems should operate on top of — so that memory persists, workflows transfer, tools stay replaceable, and every outcome can be traced, audited, and replayed.

---

## Tech Stack

| Component | Technology |
|---|---|
| Runtime | TypeScript (Control Plane + Workers) |
| Event Bus | [iii-engine](https://github.com/iii-hq/iii) — Rust async bus |
| Database | PostgreSQL — `pgcrypto` (SHA-256), `pgvector` (HNSW search), list partitioning |
| LLM Interface | OpenAI-compatible REST (`/v1/`) — works with OpenAI, Ollama, llama.cpp |

---

## Further Reading

| Document | Description |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | Canonical domain glossary — precise definitions for all system terms |
| [`docs/RFC_v4.md`](docs/RFC_v4.md) | Full system RFC — complete design rationale and specification |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture deep-dive with Mermaid sequence diagrams |
| [`docs/ADR_v4.md`](docs/ADR_v4.md) | All 23 Architectural Decision Records |
