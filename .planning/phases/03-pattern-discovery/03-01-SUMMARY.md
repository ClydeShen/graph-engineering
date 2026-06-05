---
phase: 03-pattern-discovery
plan: "01"
subsystem: schema + workers + tests
tags: [migration, embedding, agent-registry, wave-0, tdd, pattern-discovery]
dependency_graph:
  requires: [02-08-PLAN.md]
  provides: [agent_registry table, intent_embedding column, cross_domain_cluster_id column, AGENT_HEARTBEAT_TTL_S, GATE4-1/2/4/5 scaffolds]
  affects: [FrontierScheduler skill-matching (Plan 03-03), CrossScopePatternDiscoveryWorker (Plan 03-02), MCP Server (Plan 03-05)]
tech_stack:
  added: []
  patterns: [idempotent SQL migration, EmbeddingProvider injection, Wave-0 RED scaffolds, it.todo RED stubs]
key_files:
  created:
    - migrations/007-pattern-discovery-mcp.sql
    - packages/workers/src/patterns/cross-scope.test.ts
    - packages/gateway/src/routes/mcp.test.ts
    - packages/workers/src/scheduler/frontier.test.ts
  modified:
    - packages/workers/src/memory/procedural.worker.ts
    - packages/workers/src/memory/procedural.worker.test.ts
    - packages/workers/src/memory/gate3.integration.test.ts
    - packages/workers/src/index.ts
    - packages/shared/src/constants.ts
    - packages/workers/src/memory/wl-embedding.test.ts
decisions:
  - "EmbeddingProvider (not LLMProvider) injected into ProceduralMemoryWorker — only embed() is needed; avoids coupling to chat() interface"
  - "intent_embedding NULL-fallback on provider failure: topology_embedding (never NULL) is the load-bearing index column; intent_embedding is only the cross-domain guard filter"
  - "GATE4-1 cosine test PASSES at Wave-0 — WL kernel is already structure-label-invariant at event_type level; node ID labels do not affect the hash histogram"
  - "cross-scope.test.ts uses dynamic import to avoid TS2307 at compile time while preserving runtime RED failure on missing module"
metrics:
  duration: "~30 minutes"
  completed: "2026-06-05"
  tasks_completed: 3
  files_modified: 10
---

# Phase 3 Plan 01: Wave-0 Schema + Worker + RED Scaffolds Summary

**One-liner:** Migration 007 creates agent_registry (GIN skills index) + adds intent_embedding vector(1536) and cross_domain_cluster_id to procedural_memory; ProceduralMemoryWorker extended to write intent_embedding via injected EmbeddingProvider; four Wave-0 RED test scaffolds establish GATE4 baselines.

## Tasks Completed

| Task | Name | Commit | Status |
|------|------|--------|--------|
| 1 | Write migration 007-pattern-discovery-mcp.sql | 625c11e | Done |
| 2 | ProceduralMemoryWorker intent_embedding + AGENT_HEARTBEAT_TTL_S | 9afaa1c | Done |
| 3 | Wave-0 RED scaffolds for GATE4-1, GATE4-2, GATE4-4, GATE4-5 | 09fa5aa | Done |

## Artifacts

### migrations/007-pattern-discovery-mcp.sql
- `CREATE TABLE IF NOT EXISTS agent_registry` with all columns per DESIGN.md §3.2
- `CREATE INDEX IF NOT EXISTS idx_agent_registry_skills ON agent_registry USING GIN (skills)` — enables `&&` overlap queries for skill-based dispatch (D-1)
- `CREATE INDEX IF NOT EXISTS idx_agent_registry_status_heartbeat ON agent_registry (status, last_heartbeat) WHERE status = 'active'` — heartbeat-gated active agent lookups
- `ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS intent_embedding vector(1536)` — semantic embedding for cross-domain guard filter
- `ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS cross_domain_cluster_id UUID` — cluster assignment by CrossScopePatternDiscoveryWorker
- `CREATE INDEX IF NOT EXISTS idx_procedural_cross_domain_cluster` — B-tree partial index for cluster membership lookups
- No HNSW on intent_embedding (RESEARCH Pitfall 1: topology HNSW + small candidate set is sufficient)
- All statements idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)

### packages/workers/src/memory/procedural.worker.ts
- Constructor changed from `(pool: Pool)` to `(pool: Pool, llm: EmbeddingProvider)`
- `onSynthesizerOutput` calls `llm.embed(intentDescription)` after computing WL topology embedding
- Intent embedding formatted as `[v0,v1,...]` bracketed pgvector literal and passed as `$6`
- NULL fallback on provider failure; topology_embedding (`$5`) never NULL (HNSW guard preserved)
- INSERT column list extended to include `intent_embedding`

### packages/shared/src/constants.ts
- `AGENT_HEARTBEAT_TTL_S = 60` added with ADR-37/DESIGN §3.2 JSDoc

### packages/workers/src/index.ts
- `new ProceduralMemoryWorker(pool, llmProvider)` — llmProvider already existed in file

### Wave-0 RED scaffolds

| File | GATE | Status | Plan to turn GREEN |
|------|------|--------|--------------------|
| packages/workers/src/memory/wl-embedding.test.ts | GATE4-1 | PASSES (WL kernel already label-invariant) | 03-01 (done) |
| packages/workers/src/patterns/cross-scope.test.ts | GATE4-2 | RED (cross-scope.ts not yet created) | 03-02 |
| packages/gateway/src/routes/mcp.test.ts | GATE4-4 | RED (mcp.ts not yet created) | 03-05 |
| packages/workers/src/scheduler/frontier.test.ts | GATE4-5 | RED (it.todo stubs) | 03-03 |

## Verification Results

| Check | Result |
|-------|--------|
| `npm run typecheck` | PASS (exit 0) |
| `vitest run procedural.worker.test.ts` | PASS (8/8 tests) |
| `vitest run wl-embedding.test.ts` | PASS (6/6 tests, GATE4-1 cosine 1.0) |
| `grep -c AGENT_HEARTBEAT_TTL_S constants.ts` | 1 |
| `grep -c intent_embedding procedural.worker.ts` | 3 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] gate3.integration.test.ts: ProceduralMemoryWorker(pool) → ProceduralMemoryWorker(pool, mockLlm)**
- **Found during:** Task 2 (constructor signature change propagation)
- **Issue:** G3-3 integration test called `new ProceduralMemoryWorker(pool)` — now a TypeScript error after constructor change
- **Fix:** Added inline `mockLlmForG3` stub that returns `{ vector: [], countedAgainstBudget: false }` — embed failure falls back to NULL intent_embedding (safe; topology write unaffected)
- **Files modified:** packages/workers/src/memory/gate3.integration.test.ts
- **Commit:** 9afaa1c

**2. [Rule 1 - Bug] cross-scope.test.ts: static type import replaced with dynamic import to avoid TS2307**
- **Found during:** Task 3 typecheck
- **Issue:** `import type { discoverClusters } from './cross-scope.js'` fails typecheck because cross-scope.ts doesn't exist yet (intended RED module)
- **Fix:** Replaced static type import with inline type annotation + guarded `import('./cross-scope.js' as string)` dynamic import. The runtime RED behavior (expect.fail) is preserved; typecheck no longer errors.
- **Files modified:** packages/workers/src/patterns/cross-scope.test.ts
- **Commit:** 09fa5aa

### Notable Decisions

- **GATE4-1 passes immediately:** The WL kernel hashes `event_type` labels (not node ID strings) when computing the WL iteration labels. Both domain graphs use the same `event_type` values (`task_spawned`, `memory_updated`, `scope_closed`), so the histogram vectors are identical — cosine similarity is 1.0. This is a valid Wave-0 signal: the kernel IS already structure-label-invariant for same-event-type topology. Cross-domain discovery (Plan 03-02) will work with the existing kernel.

- **frontier.test.ts created (not extended):** The existing frontier tests live at `src/__tests__/frontier.test.ts`. The plan spec `packages/workers/src/scheduler/frontier.test.ts` did not exist — a new file was created with GATE4-5 RED stubs only (not duplicating the existing dynamicScore tests).

## Known Stubs

None — no UI rendering stubs or placeholder data introduced in this plan.

## Threat Flags

No new threat surface beyond what is documented in the plan's threat model.
Migration 007 follows established IF NOT EXISTS idempotency pattern (T-03-01-01 mitigated).
Intent embedding call reuses existing LLM provider boundary (T-03-01-02 accepted — same boundary as SemanticMemoryWorker).
Provider failure gracefully falls back to NULL (T-03-01-03 mitigated).
