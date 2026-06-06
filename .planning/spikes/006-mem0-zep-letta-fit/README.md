# Spike 006 — Mem0 / Zep / Letta Fit

**Status:** INVALIDATED
**Date:** 2026-06-06
**Question:** Can Mem0, Zep, or Letta replace or augment the custom 4-layer memory system?

---

## Verdict: INVALIDATED — all three libraries

All three libraries assume they are the **single source of truth** for agent memory. This is architecturally incompatible with this system, where the SSOT is a **PostgreSQL append-only execution graph** (immutable event log, OCC with causal inversion). None can be layered on top without replacing the execution graph itself.

The custom 4-layer build is **justified**.

---

## Evidence per library

### Mem0

- **Architecture:** Vector store (pgvector, Qdrant, Weaviate) + graph store (Neo4j) + SQLite for history. LLM-driven extraction pipeline converts raw messages into structured memories.
- **Key incompatibility:** Memory write path is non-deterministic — an LLM decides what to extract, update, or delete. This violates the append-only + OCC invariant: Mem0 performs in-place updates and deletes on memories.
- **pgvector backend:** Supported, but Mem0 still owns its own schema and mutates rows. Cannot be pointed at `execution_event_log`.
- **Conclusion:** Mem0 solves *conversational* memory (chat history distillation), not *execution trace* memory. Different problem domain.

### Zep

- **Architecture (Community Edition):** Self-hosted server with its own PostgreSQL schema + dialog graph. **Deprecated** — CE is EOL, cloud-only going forward.
- **Architecture (Graphiti engine):** Knowledge graph engine underlying Zep cloud. Requires **Neo4j**, not PostgreSQL. Edges are mutable temporal facts.
- **Key incompatibility:** Zep's Graphiti model uses bi-temporal mutable edges. Our hyper-edges are immutable append-only. Zep would need to be the event store, not a layer above it.
- **Conclusion:** CE deprecated; Graphiti requires Neo4j and mutable graph semantics — incompatible at the storage layer.

### Letta

- **Architecture:** Stateful agent framework with a separate Letta Server. Memory is stored in typed "blocks" (persona, human, archival) — all mutable text documents.
- **Key incompatibility:** Letta requires a separate server process. Memory blocks are mutable, versioned by Letta's own internal system — not by predecessor_hash chains. Letta is designed to BE the agent runtime, not a memory subsystem within one.
- **Conclusion:** Letta is an alternative full runtime, not a composable library. Cannot be embedded as a memory layer.

---

## Why the custom 4-layer build was correct

The **CoALA paper** (arXiv:2309.02427, Princeton/CMU 2023) defines the cognitive architecture this system implements:

| Layer | CoALA term | This system |
|---|---|---|
| Working | Working memory | `execution_event_log` (current scope) |
| Episodic | Episodic memory | `episodic_memory` (scope summaries) |
| Semantic | Semantic memory | `semantic_memory` (superseded_by chain) |
| Procedural | Procedural memory | `procedural_memory` (template_graph JSONB, WL embedding) |

No library surveyed implements procedural memory as graph topology embeddings (WL kernel). None supports the append-only OCC write model. The custom build is grounded in established cognitive science.

---

## Research gap identified

This comparison should have been done **before** building episodic + semantic layers. If any library had been compatible, it could have eliminated ~2 weeks of implementation. The prior research checklist should include: "Is there an existing agent memory library compatible with an append-only SSOT?"

---

## Recommendation

- **No action on 4-layer memory** — keep custom build as-is.
- **Document this finding** in `.harness/phases/04-external-integrations/04-PLAN.md` decision log.
- **Future consideration:** If the system ever adds a conversational interface layer (outside execution graph), Mem0 with pgvector backend could handle chat-level memory without touching the graph.
