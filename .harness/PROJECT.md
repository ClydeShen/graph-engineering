# Project: Memex — Graph-Native Agent Runtime

> "The human mind operates by association." — Vannevar Bush, *As We May Think* (1945)

## Vision

A system for discovering reusable workflows from execution trails — not designing them. Inspired by Vannevar Bush's 1945 Memex concept: knowledge organized as associative trails, not hierarchical indexes. There is no workflow layer. Memory, workflow, context, and state are all views of the same append-only Trail Mesh. The context window is a projection of the graph; the Trail Mesh is the permanent record. Workflows emerge as statistical patterns from accumulated trails, including cross-domain topologies that are invisible at the level of individual tasks.

## Goals

- Append-only Trail Mesh (PostgreSQL) as single source of truth for all state
- Context assembly as causal trail projection from graph lineage, not prompt engineering
- Trail Discovery: workflow pattern emergence from execution history — across task types, not just within them
- Multi-agent coordination with automatic conflict resolution (no exceptions, no lost work)
- Crystallization: LLM distillation of raw trails into durable Lessons with Ebbinghaus reinforcement
- Full causal auditability: every outcome traceable to the Association that caused it

## Status

Design phase — domain model and architecture documented in CONTEXT.md, RFC_v4.md, ADR_v4.md.

## Stack (confirmed, 2026-06-01)

| Layer | Technology |
|---|---|
| Storage & SSOT | PostgreSQL 15+ (append-only event log, pgcrypto SHA-256, pgvector HNSW) |
| Event bus / Worker routing | **iii Engine** (pre-installed binary, `npm install iii-sdk` for SDK) |
| Control Plane Daemon | **TypeScript** — `pg-listen` LISTEN/NOTIFY → `iii.trigger()` bridge; DDL exclusive connection; HWM |
| Workers | **TypeScript** — `iii-sdk` registerWorker + registerFunction; SELECT/INSERT only DB credentials |
| Tokenizer | **Wasm** — `@dqbd/tiktoken` (Rust tiktoken-rs → Wasm); Node.js 2-line load; BPE accuracy for W_max |
| LLM / Embedding | OpenAI-compatible REST (`/v1/chat/completions` + `/v1/embeddings`); ollama / llama.cpp / OpenAI |

## Key Docs

- `CONTEXT.md` — domain glossary (canonical)
- `docs/RFC_v4.md` — RFC
- `docs/ADR_v4.md` — ADR overview (23 ADRs locked)
- `docs/adr/` — individual ADR supplements (ADR 20–23)
- `docs/ARCHITECTURE.md` — implementable arch doc (ASCII diagram, Mermaid flows, external citations §11)
- `docs/TECH_STACK.md` — tech stack with official URLs and copy-pasteable code index
