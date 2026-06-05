---
phase: 03-pattern-discovery
plan: "02"
subsystem: pattern-discovery
tags:
  - cross-scope
  - union-find
  - clustering
  - pattern-discovery
  - ADR25
  - ADR37
  - GATE4-2
dependency_graph:
  requires:
    - 03-01  # intent_embedding column + migration 007 must exist
  provides:
    - discoverClusters (cross-scope.ts)
    - assignClusters (cross-scope.ts)
    - PatternDiscoveryWorker.runDiscovery wired (discover.worker.ts)
  affects:
    - procedural_memory.cross_domain_cluster_id (written by discoverClusters)
    - GATE4-2 (now GREEN)
tech_stack:
  added: []
  patterns:
    - union-find / disjoint-set (pure TypeScript, no library)
    - per-row HNSW ANN search (ORDER BY topology_embedding <=> $1 LIMIT 50) to avoid full-table scan (Pitfall 1)
    - idempotent UPDATE with WHERE cross_domain_cluster_id IS NULL guard (Pitfall 5)
key_files:
  created:
    - packages/workers/src/patterns/cross-scope.ts
  modified:
    - packages/workers/src/patterns/cross-scope.test.ts
    - packages/workers/src/patterns/discover.worker.ts
decisions:
  - "Per-row ANN search form (not self-JOIN on <=>) to ensure HNSW index is used — ADR 25 / RESEARCH Pitfall 1"
  - "Topology cosine threshold 0.90 (distance < 0.10), intent distance threshold 0.50 — Claude's discretion per CONTEXT.md"
  - "assignClusters is a pure function (no DB) to enable unit testing without DATABASE_URL"
  - "discoverClusters returns void — side effects only; runDiscovery return type unchanged ({ skipped: boolean })"
metrics:
  duration_minutes: 15
  completed_date: "2026-06-05"
  tasks_completed: 2
  tasks_total: 2
  files_changed: 3
---

# Phase 3 Plan 02: CrossScopePatternDiscoveryWorker + union-find clustering Summary

**One-liner:** Pure union-find `assignClusters` + DB-backed `discoverClusters` with per-row HNSW ANN and idempotent `WHERE cross_domain_cluster_id IS NULL` guard; wired into `PatternDiscoveryWorker.runDiscovery` after the corpus guard (ADR 25 / ADR 37).

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Implement cross-scope.ts (pair discovery + union-find) | 556274b | packages/workers/src/patterns/cross-scope.ts, packages/workers/src/patterns/cross-scope.test.ts |
| 2 | Wire discoverClusters into PatternDiscoveryWorker.runDiscovery | 07211c1 | packages/workers/src/patterns/discover.worker.ts |

## What Was Built

### Task 1 — `cross-scope.ts`

Created `packages/workers/src/patterns/cross-scope.ts` exporting two functions:

**`assignClusters(pairs: [string, string][]): Map<string, string>`**
- Pure union-find / disjoint-set implementation with path compression
- Takes an array of `[id_a, id_b]` edges; groups connected components; assigns one `randomUUID()` per distinct root
- No DB access — fully unit-testable

**`discoverClusters(pool, topologyCosineThreshold=0.90, intentDistanceThreshold=0.50): Promise<void>`**
- Step 1: SELECT all un-clustered, non-anti-pattern templates with both embeddings (topology + intent) non-NULL
- Step 2: Per-row HNSW ANN query `ORDER BY topology_embedding <=> $1 LIMIT 50` with `topology distance < 0.10 AND intent distance > 0.50` filter
- Step 3: Run `assignClusters` over collected pairs
- Step 4: Idempotent `UPDATE procedural_memory SET cross_domain_cluster_id = $1 WHERE id = $2 AND cross_domain_cluster_id IS NULL`

### Task 2 — `discover.worker.ts` extension

- Added `import { discoverClusters } from './cross-scope.js'`
- Replaced Phase 1 stub body with `await discoverClusters(pool)` after the existing corpus guard
- Preserved all invariants: cron-only, no GraphHandle, no OCC write, no frontier dispatch (ADR 37)
- Return type unchanged: `{ skipped: boolean }`

### GATE4-2 test turned GREEN

Updated `cross-scope.test.ts` from placeholder scaffold to real assertions:
- 5 union-find unit tests (disjoint pairs, chain, single pair, empty, UUID format) — all **PASS**
- 1 DB integration test — **SKIPPED** (no DATABASE_URL in this environment; correct behavior)

GATE4-1 (`wl-embedding.test.ts`) also confirmed passing (6/6).

## Verification

```
npx vitest run packages/workers/src/patterns/cross-scope.test.ts
  ✓ 5 tests pass | 1 skipped (no DATABASE_URL)

npx vitest run packages/workers/src/memory/wl-embedding.test.ts
  ✓ 6 tests pass (GATE4-1 confirmed)

npm run typecheck
  ✓ exits 0

grep -c "cross_domain_cluster_id IS NULL" packages/workers/src/patterns/cross-scope.ts
  → 5 (idempotency guard present — SELECT WHERE clause + UPDATE WHERE clause)

grep -c "discoverClusters" packages/workers/src/patterns/discover.worker.ts
  → 2 (import + call)
```

## Deviations from Plan

None — plan executed exactly as written.

The test scaffold update was minimal: replaced the `expect(true).toBe(true)` placeholder with real `assignClusters` assertions (5 tests). The DB integration test structure was preserved unchanged from the Plan 01 scaffold.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced in this plan. `discoverClusters` writes only to `procedural_memory.cross_domain_cluster_id` via idempotent UPDATE — covered by T-03-02-01 in the plan threat register. No new threat flags.

## Known Stubs

None. `discoverClusters` is fully implemented and connected to `runDiscovery`. The DB integration test requires `DATABASE_URL` to run the live seeding/assertion path — this is intentional gating, not a stub.

## Self-Check: PASSED

- [x] `packages/workers/src/patterns/cross-scope.ts` exists (created)
- [x] `packages/workers/src/patterns/discover.worker.ts` contains `discoverClusters` (2 occurrences)
- [x] Commit 556274b exists: feat(03-02): CrossScopePatternDiscoveryWorker — assignClusters + discoverClusters
- [x] Commit 07211c1 exists: feat(03-02): wire discoverClusters into PatternDiscoveryWorker.runDiscovery
- [x] GATE4-2 unit tests green (5/5)
- [x] GATE4-1 tests green (6/6)
- [x] `npm run typecheck` exits 0
