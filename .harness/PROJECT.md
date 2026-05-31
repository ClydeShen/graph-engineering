# Project: Graph-Native Agent Runtime

## Vision

A graph-native agent runtime where an immutable event graph serves as the single source of truth. Decentralized event bus drives multi-agent collaboration. Blockchain-ledger philosophy ensures tamper-proof state and adaptive evolution.

## Goals

- Immutable, append-only execution graph stored in PostgreSQL
- Cryptographic version hashing (SHA-256 via pgcrypto)
- Multi-agent coordination over a decentralized event bus
- Full auditability via predecessor hash chains

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
