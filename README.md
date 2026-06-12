# Memex

> "The human mind operates by association. With one item in its grasp, it snaps instantly to the next that is suggested by the association of thoughts, in accordance with some intricate web of trails carried by the cells of the brain."
> — Vannevar Bush, *As We May Think* (1945)

Memex is a graph-native agent runtime that externalizes cognitive work as an append-only associative graph. There is no workflow engine. There are no pipeline definitions. What appears as a "workflow" is a statistical pattern that emerges from accumulated execution traces — Bush's *trails*, made computable.

---

## The Idea

In 1945, Vannevar Bush described a hypothetical device — the Memex — that would extend human memory not through filing cabinets and hierarchical indexes, but through *associative trails*. The human mind, he observed, does not index. It associates. One thought snaps to the next through a web of connections forged by use and experience.

This system operationalizes that idea for AI agents.

| Bush's Memex (1945) | This System |
|---|---|
| Memex device | The runtime itself — externalized cognitive memory |
| Trail | Cognitive Trace — full execution record including deviations |
| Association | Hyper-edge — directed, immutable link between entities |
| Item | Entity — addressable knowledge unit with stable UUID |
| Trail blazing | Writing hyper-edges; connecting entities across time |
| Trail Mesh | Execution Graph — aggregate of all trails, single source of truth |
| Shared trail | Emerged workflow pattern — reusable graph topology |
| Compression into memory | Crystallization — LLM distillation of trails into Lessons |

One critical extension beyond Bush: his Memex was passive — it recorded what humans chose to link. This system is active. It crystallizes raw trails into durable Lessons through an LLM distillation step, and reinforces those Lessons on an Ebbinghaus confidence schedule. The Memex doesn't just remember — it learns.

---

## Core Principles

### No Workflow Layer

There is no workflow engine. No DAG. No pipeline definition. When you observe a repeating "workflow" in Memex, you are observing a statistical regularity in the Trail Mesh — a topology that has recurred across enough executions to be recognized. It was not designed. It was discovered.

This is the central inversion: most systems define workflows and then execute them. Memex executes, accumulates trails, and surfaces structure from the aggregate. The trail comes first. The pattern is the residue.

### Context as Trail Projection

The agent's context window is not state — it is a *projection* of the Trail Mesh. Each call assembles context from the causal lineage of the current trail. `Graph → Context`, never `Context = State`. The Memex is the permanent record; the context window is a lens over it.

### Trails Include Deviations

Unlike systems that record only successful paths, Memex records everything: successful paths, deviations, conflicts, retries. Deviations are not noise — they are signal. A trail that always deviates at the same point is telling you something about the terrain. Conflict resolution is automatic and lossless; no work is discarded.

### Crystallization

When a Scope closes, CrystallizeWorker queries the episodic trail, calls an LLM to distill structure and insight, and writes a Crystal entity. The Crystal triggers LessonSaveWorker, which deduplicates by SHA-256 fingerprint and reinforces confidence via the Ebbinghaus formula: `confidence += 0.1 * (1 - confidence)`. Lessons that cross the export threshold become portable skill definitions in agentskills.io format.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                            Memex                                │
│                                                                 │
│   Agent                                                         │
│     │                                                           │
│     ▼                                                           │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  MemexShell — MemexTerminal · Dashboard · CLI · Bots     │   │
│  │  Telegram · Discord · Slack · Email · Webhook · Cron     │   │
│  └──────────────┬───────────────────────────────────────────┘   │
│                 │ REST + WS/SSE                                  │
│  ┌──────────────▼───────────────┐                               │
│  │  Gateway (Hono + MCP/HTTP)   │  ← Claude Code, Pi Terminal,  │
│  └──────────────┬───────────────┘     external MCP agents       │
│                 │ iii.trigger()                                  │
│     ┌───────────▼──────────────────────────────────┐            │
│     │              iii Engine (Worker Bus)          │            │
│     │                                              │            │
│     │  SpawnWorker   ConflictResolver   Frontier   │            │
│     │  CrystallizeWorker   LessonSaveWorker        │            │
│     │  TemplateProposalWorker  PatternDiscoveryWorker │         │
│     └───────────────────────┬──────────────────────┘            │
│                             │ OCC writes                        │
│     ┌───────────────────────▼──────────────────────┐            │
│     │          Trail Mesh (PostgreSQL)              │            │
│     │                                              │            │
│     │  entities  versions  hyper_edges             │            │
│     │  episodic_memory  semantic_memory            │            │
│     │  procedural_memory  lessons  crystals        │            │
│     │  pgvector HNSW  pgcrypto SHA-256             │            │
│     └──────────────────────────────────────────────┘            │
└─────────────────────────────────────────────────────────────────┘
```

**Trail flow:**
1. Agent or channel message calls Gateway (REST/MCP/WS) → `iii.trigger()` fires
2. Worker writes Association (hyper-edge) to Trail Mesh via OCC
3. On scope close → CrystallizeWorker distills trail → Crystal written
4. Crystal triggers LessonSaveWorker → Lesson saved with Ebbinghaus reinforcement
5. TemplateProposalWorker / PatternDiscoveryWorker scan the Trail Mesh for recurring topologies and inject proven skeletons into future Scopes — this is Trail Discovery

---

## Key Concepts

| Term | Definition |
|---|---|
| **Trail** | Full execution record within a Scope (CognitiveTrace); includes deviations, conflicts, retries |
| **Association** | Directed immutable hyper-edge `(source, target, event_type, version_hash, timestamp)` |
| **Entity** | Logical object with stable UUID; addressable across all trails that touched it |
| **Snapshot** | Immutable state of an Entity at a point in time; content-addressed by SHA-256 |
| **Trail Mesh** | Aggregate of all Trails and Associations; single source of truth |
| **Scope** | Bounded workspace where a trail is recorded; one agent session or sub-task |
| **Crystallization** | LLM distillation of a closed trail into a durable Lesson |
| **Lesson** | Extracted insight; confidence-weighted; reinforced by Ebbinghaus schedule |
| **Trail Discovery** | Statistical emergence of reusable patterns from Trail Mesh history |
| **Cross-Domain Topology** | Trail structures recurring across unrelated task types; visible only in aggregate |

---

## Stack

| Layer | Technology |
|---|---|
| Trail Mesh (SSOT) | PostgreSQL 16+ — append-only event log, pgcrypto SHA-256, pgvector HNSW |
| Worker Routing | iii Engine — event-driven worker bus |
| Gateway | Hono + MCP Streamable HTTP + WS/SSE realtime — agent entry point |
| Workers | TypeScript — iii-sdk `registerWorker` + `registerFunction` |
| LLM Providers | Anthropic Messages API + OpenAI-compatible (Ollama/vLLM/LM Studio/DeepSeek), registry + fallback |
| Memory | Episodic / Semantic / Procedural — hybrid BM25 + pgvector HNSW (RRF) retrieval |
| Shell | MemexTerminal (TUI), Dashboard (live SSE view), `memex` CLI |
| Connectors | Telegram, Discord, Slack, Email, inbound Webhook (HMAC) + graph-native cron |
| Security | CommandGate (3-tier), docker execution backend, cross-channel approvals, erase(scope) |

---

## Development Phases

| Phase | Description | Status |
|---|---|---|
| 01 — discuss | Domain model, terminology, RFC ratification | Complete |
| 02 — plan | Architecture, data model, ADRs | Complete |
| 03 — execute | PostgreSQL schema, event bus, hash chain, workers | Complete |
| 04 — external-integrations | MCP gateway, connect CLI, distributed locking, crystallization | Complete |
| 05 — provider-safety | Anthropic adapter, CommandGate, skill export, webhook notify | Complete |
| 06 — extensions | MCP client, execute_bash, gateway-bot, UserProfile, pairing | Complete |
| 07 — architecture | Memory repository seam, lifecycle/graph-handle refactor | Complete |
| 08 — context-assembly | Knapsack slicing, CCR compression, Wasm tokenizer | Complete |
| 09 — memory-layers | Episodic / semantic / procedural memory, hybrid retrieval | Complete |
| 10 — trail-discovery | Template proposal/injection, pattern discovery, reinforcement | Complete |
| 11 — memex-shell | Realtime WS/SSE, onboarding TUI, MemexTerminal, Dashboard | Complete |
| 12 — connector-matrix | Telegram/Discord/Slack/Email/Webhook, graph-native cron | Complete |
| 13 — agent-federation | Sub-agent delegation, agent registry, visibility domains | Complete |
| 14 — trust-isolation | Docker execution backend, approvals, erase, PII filtering | Complete |
| 15 — deploy-everywhere | Installers, Docker compose, doctor, backup/restore, profiles | Complete |
| 16 — memexos-one | Skills install side, eval harness, SECURITY/QUICKSTART, release | Complete |
| 17 — mcp-connector-ecosystem | MCP catalog, OAuth PKCE, `memex mcp` CLI | Planned |

Phases 1–16 form the **1.0 candidate** (479 tests, `tsc` clean). See `.harness/ROADMAP.md` for full phase detail and `CHANGELOG.md` for the release notes.

---

## Documentation

- **[docs/QUICKSTART.md](docs/QUICKSTART.md)** — install and blaze your first Trail in five minutes
- **[docs/USER_MANUAL.md](docs/USER_MANUAL.md)** — full user manual: installation (all platforms), configuration, every feature, troubleshooting
- **[docs/api/reference.md](docs/api/reference.md)** — REST + MCP API reference
- **[docs/guides/](docs/guides/)** — developer guides (getting started, configuration, deployment, development)
- **[SECURITY.md](SECURITY.md)** — trust model and vulnerability disclosure
- **[docs/adr/](docs/adr/)** — architectural decision records

---

## Philosophy

> "Presumably man's spirit should be elevated if he can better review his shady past and analyze more completely and objectively his present problems."
> — Vannevar Bush, *As We May Think* (1945)

Memex is not a productivity tool. It is an attempt to give AI agents genuine external memory — memory that accumulates across sessions, that learns from repetition, and that surfaces structure no single agent context window could perceive. The Trail Mesh grows with every execution. The Lessons compound. The patterns emerge.

Bush imagined this for human scholars navigating the explosion of recorded knowledge. We are building it for agents navigating an explosion of tasks, contexts, and executions — giving them a mesh of trails to navigate, rather than a blank slate to start from.
