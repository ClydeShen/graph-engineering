# Graph-Native Agent Runtime

> A tamper-proof, self-learning runtime for multi-agent AI systems — where every decision is permanent, every mistake is a lesson, and the system gets smarter every time it runs.

---

## The Vision

AI agents today are powerful but fragile. They think, act, and forget. When something goes wrong — a tool crashes, two agents disagree, the context fills up — there's no reliable audit trail, no way to recover gracefully, and no mechanism to learn from the failure.

This project sets out to build a runtime where **AI agents operate like a decentralized, self-healing organism**: every thought, every action, and every failure is recorded as an immutable fact in a shared graph. The system never forgets, never lies, and gets better with every task it completes.

---

## The Problem

Modern AI agent frameworks suffer from three fundamental flaws:

**1. Brittle tool coupling**
Agent logic is hardwired to specific tools. If a tool fails, the whole pipeline breaks — there's no graceful fallback, no self-healing.

**2. Non-reusable workflows**
Every new task starts from scratch. Even if the agent has solved the same class of problem a hundred times, that knowledge is lost when the context window closes.

**3. "Lost in the Middle" hallucination**
As tasks grow complex, dumping raw history into the LLM causes it to lose track of what matters. The agent starts contradicting itself, repeating work, or fabricating answers.

---

## The Solution

The core insight is borrowed from **blockchain ledger philosophy**: instead of letting agents mutate shared state and argue about what's true, every action becomes an immutable **append-only event** in a cryptographically linked graph.

Think of it like a **Git repository for agent cognition**:
- Every decision is a commit with a hash, a parent pointer, and a payload.
- You can never rewrite history — only add to it.
- Conflicts are resolved by merging, not by one agent overwriting another.
- The full lineage of every outcome is always traceable.

But unlike Git, this system is **alive**: it learns from each completed task, extracts reusable workflow templates, and injects them into future runs automatically. No human re-writes the code. The system evolves itself.

---

## How It Works — A Simple Example

Imagine you ask the system: *"Research competitors and draft a positioning report."*

### Step 1 — A new Scope is born
The system creates a **Scope** — a logical container for this entire task. A root event (`plan_created`) is written to the database, with no predecessor. This is the genesis block.

```
plan_created  ←  "Research competitors and draft a positioning report"
    hash: 0xabc123...
    predecessor: null  (the root)
```

### Step 2 — Workers fan out
Specialized **Workers** subscribe to events on the event bus. The `plan_created` event wakes up a planning Worker, which breaks the task into subtasks and writes them to the graph:

```
task_spawned  ←  "Search for top 5 competitors"      hash: 0xdef456...  predecessor: 0xabc123
task_spawned  ←  "Extract their pricing pages"        hash: 0x789abc...  predecessor: 0xabc123
task_spawned  ←  "Summarize differentiators"          hash: 0x321fed...  predecessor: 0xabc123
```

Each Worker only has `SELECT` and `INSERT` access — they can only read the graph and append new facts. They cannot delete or overwrite anything.

### Step 3 — Two Workers race and conflict
Two Workers finish at the same moment and both try to advance the same node. The database's unique constraint acts as a referee:

```
Worker A wins  → memory_updated  (the canonical chain advances)
Worker B loses → conflict_detected  (demoted, but NOT discarded)
                 predecessor forced to point at Worker A's result
```

A dedicated `ConflictResolverWorker` wakes up, reads both versions, calls the LLM to semantically merge them, and writes a single reconciled `v_merged` node. **No work is lost. No exception is thrown.**

### Step 4 — The Scope closes and learns
When all tasks converge, a Watchdog checks the graph topology. Once it confirms nothing is pending, it writes `scope_closed`. This triggers a `TemplateProposalWorker` which:
- Extracts the most efficient paths as **reusable workflow templates**
- Archives failed branches as **anti-patterns to avoid**
- Writes a summary to long-term memory

**The next time someone asks a similar question, the system already knows a good path to take — without any human writing new code.**

---

## Core Concepts

| Concept | What it means |
|---|---|
| **Execution Graph** | The single source of truth. An append-only event log in PostgreSQL — everything the system has ever done or decided lives here. |
| **Version** | An immutable snapshot of a piece of work, identified by a SHA-256 hash of its content and lineage. |
| **Scope** | A container for one top-level task, spanning multiple AI context windows. Like a process group in an OS. |
| **Worker** | A stateless executor that subscribes to one event type, does one job, and writes the result back to the graph. It is destroyed after each use. |
| **Topological Horizon** | The precise slice of the graph fed to the LLM — traced backwards along predecessor hashes to the root, trimmed to fit the token budget. No random summarization; pure causal lineage. |
| **OCC** | Optimistic Concurrency Control — concurrent Workers race to write; the database constraint picks the winner atomically; the loser is reframed as a conflict, not discarded. |

---

## Architecture at a Glance

```
User Intent
    │
    ▼
┌─────────────────────────────────────────────────────────┐
│  Control Plane (TypeScript)                              │
│  • Creates the Scope (DDL: partition + HNSW index)      │
│  • Bridges DB notifications → event bus (iii-engine)    │
│  • Runs the Convergence Watchdog                        │
└──────────────────────────┬──────────────────────────────┘
                           │  WebSocket events
                ┌──────────▼──────────┐
                │  iii-engine (binary) │
                │  Routes events to   │
                │  matching Workers   │
                └──────────┬──────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
    [Worker A]        [Worker B]    [ConflictResolverWorker]
    SELECT/INSERT     SELECT/INSERT  reads both forks, merges
         │                 │                 │
         └─────────────────┴─────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  PostgreSQL — Single Source of Truth                     │
│                                                          │
│  execution_event_log   ← the living graph               │
│  episodic_memory       ← "what happened last time"      │
│  semantic_memory       ← "what we know to be true"      │
│  procedural_memory     ← "how to do it well"            │
└─────────────────────────────────────────────────────────┘
```

---

## Why This Works

Three properties that make the system trustworthy:

**Tamper-proof state** — Every node's hash is computed from its content *plus* its parent's hash. You cannot change a past event without invalidating every node that comes after it. The full chain is always verifiable.

**Decentralized control flow** — There is no central orchestrator. Workers subscribe to events and react independently. The graph is the conductor; Workers are the musicians.

**Self-evolving workflows** — After every completed Scope, the system mines its own execution history for patterns. Efficient paths become templates. Failed paths become warnings. Future runs start smarter.

---

## Tech Stack

- **Runtime**: TypeScript (Control Plane + Workers)
- **Event Bus**: [iii-engine](https://github.com/iii-hq/iii) — high-performance Rust async bus
- **Database**: PostgreSQL with `pgcrypto` (SHA-256 hashing), `pgvector` (HNSW semantic search), `pg_partman` (Scope partitioning)
- **LLM Interface**: OpenAI-compatible REST (`/v1/`) — works with OpenAI, Ollama, llama.cpp

---

## Further Reading

| Document | Description |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | Canonical domain glossary — precise definitions for all system terms |
| [`docs/RFC_v4.md`](docs/RFC_v4.md) | Full system RFC — the complete design rationale and specification |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture deep-dive with Mermaid sequence diagrams |
| [`docs/ADR_v4.md`](docs/ADR_v4.md) | All 23 Architectural Decision Records |
| [`docs/adr/`](docs/adr/) | Individual ADR files for specific subsystems |
