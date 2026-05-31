# Graph-Native Agent Runtime

## Vision

A decentralized, graph-native agent runtime where an immutable PostgreSQL append-only event log is the single source of truth for all agent execution state, memory, and control flow. Borrows blockchain-ledger philosophy: every cognitive event is tamper-evident, causally traceable, and permanently auditable.

## Problem

Current AI agent systems suffer from three structural failures:
1. **Tool tight-coupling** — business logic binds to specific APIs; any tool failure breaks the control flow
2. **Non-reusable workflows** — orchestration code is hand-wired per scenario despite recurring cognitive patterns
3. **Context black-boxing** — growing task complexity causes LLM context window overflow and "Lost in the Middle" hallucination with no deterministic recovery path

## Solution

Replace the mutable state store + application-layer control flow with a single **Execution Graph**:
- Every agent action appends a new cryptographically-chained Version node (never mutates)
- OCC via Writable CTE + `UNIQUE(predecessor_hash, scope_id)` resolves concurrent writes atomically at DB layer
- Rust async event bus (iii-engine) routes events to stateless Workers via publish-subscribe
- Four-layer memory (Working / Episodic / Semantic / Procedural) unified in PostgreSQL
- Knapsack Slicing serves each Worker a token-budgeted DAG slice — never a raw context dump

## Stack

| Layer | Technology |
|---|---|
| Storage & OCC | PostgreSQL (append-only event log, pgcrypto, pgvector HNSW) |
| Event bus | Rust (iii-engine) — pg_notify LISTEN/NOTIFY, tokio-postgres, WebSocket |
| Workers | TypeScript — JSON Schema subscription contract, Claude API (tool_choice forced) |
| Hash computation | pgcrypto `digest()` in-transaction, SHA-256, scope-salted canonical JSON |

## Key Design Decisions (locked ADRs)

| ADR | Decision |
|---|---|
| 01 | Execution Graph as SSOT — append-only PostgreSQL event log |
| 02 | Scope-salted content addressing: `{scope_id}\|{entity_id}\|{predecessor_hash}\|{event_type}\|{canonical_json}` |
| 03 | Writable CTE atomic causal inversion for OCC |
| 04 | LIST partition by scope_id (MVP: skipped, single table) |
| 05 | Three-phase nest protocol for DDL (MVP: skipped) |

## MVP Success Criteria

On a single machine, running a concurrency stress test against the same `predecessor_hash`:
1. DB produces exactly one `memory_updated` winner and N `conflict_detected` demoted rows — no errors, no deadlocks
2. Convergence watchdog correctly wakes ConflictResolverWorker
3. Worker writes a convergence node with `convergence_gate` (dual-anchor: `legitimate_basis_hash` + `conflicted_basis_hash`) back to PG
4. Two-phase ANN+RRF stored procedure on `procedural_memory` returns relevant template for the cold-start scenario

## Stakeholders

- Primary builder: ClydeShen
- Repo: https://github.com/ClydeShen/graph-enginerring
