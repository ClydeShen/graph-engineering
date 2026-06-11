---
phase: 09-memory-layers
plan: "02"
subsystem: memory-layers
tags: [template-proposal-worker, episodic-memory, orphan-detection, embedding, anti-pattern, adr-22]
dependency_graph:
  requires:
    - migrations/012-memory-embedding.sql
    - MemoryRepository.appendEpisodicSummary
    - MemoryRepository.insertProceduralTemplate (isAntiPattern)
    - TrailReader.getScopeEvents
  provides:
    - TemplateProposalWorker
    - TEMPLATE_PROPOSAL_TRIGGER_CONFIG
  affects:
    - packages/workers/src/index.ts (registration — Plan 04)
tech_stack:
  added: []
  patterns:
    - TRIGGER_CONFIG export pattern (durable:subscriber on graph::scope::closed)
    - LLM JSON parse with fallback (intent/outcome extraction)
    - Embedding with zero-vector fallback (HNSW requires non-null embedding)
    - Orphan detection via Set intersection on version_hash/predecessor_hash
    - Phase 1 C1 constraint: memory_updated event for every memory write
key_files:
  created:
    - packages/workers/src/memory/template-proposal.worker.ts
    - packages/workers/src/memory/template-proposal.worker.test.ts
  modified: []
decisions:
  - "detectOrphanEntityIds: entity is orphan iff its version_hash NOT in predecessorHashes Set — terminal nodes never consumed as input"
  - "ZERO_TOPOLOGY_EMBEDDING is 128-dim (matches WL kernel output dim); fallback embedding for episodic is 1536-dim (OpenAI embedding dim)"
  - "Orphan write failures are swallowed (try/catch per orphan) — single orphan write failure must not break the episodic write path"
  - "LLM parse fallback: intentSummary = llmResponse.substring(0,300), outcomeSummary = 'outcome extraction failed' — episodic row is always written"
metrics:
  duration_minutes: 8
  completed_date: "2026-06-11"
  tasks_completed: 2
  files_modified: 0
  files_created: 2
---

# Phase 9 Plan 02: TemplateProposalWorker Summary

**One-liner:** TemplateProposalWorker (TPW) fires on graph::scope::closed, reads full Scope DAG via TrailReader.getScopeEvents, LLM-extracts intent+outcome with JSON fallback, writes embedding-indexed episodic records, and detects orphan terminal nodes as procedural anti-patterns in a single pass.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | TemplateProposalWorker implementation | 6e726bae | packages/workers/src/memory/template-proposal.worker.ts |
| 2 | TemplateProposalWorker unit tests | bc899947 | packages/workers/src/memory/template-proposal.worker.test.ts |

## Deviations from Plan

None — plan executed exactly as written.

## Key Decisions

1. **ZERO_TOPOLOGY_EMBEDDING is 128-dim** — matches WL kernel output dimension (procedural_memory topology_embedding). The 1536-dim zero vector is used as fallback for episodic embedding on provider failure (OpenAI dimension).
2. **detectOrphanEntityIds uses Set intersection** — predecessorHashes collects all `predecessor_hash` values; any event whose `version_hash` is absent from that Set is a terminal node. Runs purely in TypeScript over the EventLogNode array with no DB round-trip.
3. **Orphan write failures are swallowed per-orphan** — each orphan write is in its own try/catch so a single DB error doesn't abort the others or affect the already-completed episodic write.
4. **LLM parse fallback writes episodic row unconditionally** — if JSON.parse fails, the raw LLM response (truncated to 300 chars) becomes intentSummary. The episodic row is always written; no scope_closed event is silently dropped.
5. **Merge from master before implementation** — worktree was created from commit 53b79081 (pre-Phase 9). Merged master (092be4f4) to get Plan 01's interfaces (MemoryRepository.appendEpisodicSummary, TrailReader.getScopeEvents, StubMemoryRepository.calls) before implementing.

## Known Stubs

None — all writes are fully wired. ZERO_TOPOLOGY_EMBEDDING is intentional by design (D-03: Phase 10 backfills real WL topology embeddings for orphan anti-pattern rows).

## Threat Flags

None — writeGuard applied to all string values before LLM calls and DB writes. No new network endpoints introduced.

## Self-Check: PASSED

- `packages/workers/src/memory/template-proposal.worker.ts` exists
- `packages/workers/src/memory/template-proposal.worker.test.ts` exists
- Commit 6e726bae (feat) and bc899947 (test) present in git log
- TypeScript: zero errors (`npm run typecheck`)
- Tests: 6/6 pass (`npx vitest run packages/workers/src/memory/template-proposal.worker.test.ts`)
