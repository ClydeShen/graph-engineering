---
name: project-arch-review-candidates
description: Architecture review run 2 findings — Candidates A/B/C to implement before Phase 6; run 1 Candidates 1+3 already shipped (b6eacd8c)
metadata: 
  node_type: memory
  type: project
  originSessionId: 90d3e1f6-9a76-4f7d-a817-eb8a348a8f4a
---

Architecture review run 2 complete (2026-06-10). Three candidates identified before Phase 6.

**Why:** roam health 5/100 driven by pool coupling (9 workers bypass abstraction) and monolithic bootstrap. 5 of 8 "critical" bottlenecks are intentional seams or already fixed.

**How to apply:** Implement A → C before starting GSD Phase 6 (gateway-seam-extraction). HTML report at `C:\Users\Kuraido\AppData\Local\Temp\architecture-review-20260610b.html`.

## Candidates (ordered by priority)

**Candidate A — EventWriter seam (Strong)**
- 9 workers take `pool: Pool` directly to call `occWrite()`: episodic, semantic, procedural, crystallize, user-profile, sub-scope-result, conflict-resolver, mcp-client, frontier-scheduler
- Fix: `EventWriter` interface in `@graph/shared`, `OccEventWriter` adapter, replace `pool` in 9 constructors + update index.ts
- Same pattern as MemoryRepository (arch sprint Candidate 1, already proven)

**Candidate B — Bootstrap SQL extraction (Worth exploring)**
- `index.ts` (322 lines) has three blocks of inline SQL: agent_registry seed, synthesizer cron handler, user-profile agent query
- Fix: extract to dedicated modules / worker methods
- Readability tax, not blocking — can defer to Phase 7

**Candidate C — PoolTrailReader.pool visibility (Quick win)**
- `protected readonly pool` → `private readonly pool` in `packages/workers/src/base/trail-reader.ts`
- One-line change, can land in same commit as A

## Already done (run 1, commit b6eacd8c)
- Candidates 1+3 shipped: processAgentTurn extraction, makeKnapsackGraph factories, knapsackSlice {kept,dropped}. 256 tests passing, tsc clean.
- `graph` prop (betweenness 414) confirmed NOT friction — intentional permission seam (ADR 35)
- Candidates 4+5 remain deferred (PhaseGuardedHandle hierarchy, workers/index.ts hub)

[[project_arch_sprint_complete]]
