---
phase: 03-pattern-discovery
plan: "03"
subsystem: workers/scheduler
tags: [frontier-scheduler, skill-matching, agent-registry, gin-index, d1, gate4-5, tdd]
dependency_graph:
  requires: ["03-01"]
  provides: ["GATE4-5"]
  affects: ["packages/workers/src/scheduler/frontier.worker.ts"]
tech_stack:
  added: []
  patterns:
    - "GIN && operator for TEXT[] skill overlap in PostgreSQL"
    - "opt-in filter: skill-less tasks use legacy dispatch path unchanged"
    - "D-1 violation guard: forbidden assignment fields logged and stripped"
key_files:
  created: []
  modified:
    - packages/workers/src/scheduler/frontier.worker.ts
    - packages/workers/src/scheduler/frontier.test.ts
decisions:
  - "AGENT_HEARTBEAT_TTL_S passed as SQL parameter $2 (not hardcoded) to preserve testability"
  - "SKILL_MATCH_SQL exported as named constant for structural assertion tests"
  - "payload column added to FRONTIER_PRIORITY_SQL SELECT; score arithmetic byte-for-byte unchanged (ADR 31)"
  - "Per-row async skill-match (sequential) chosen over JOIN approach to keep FRONTIER_PRIORITY_SQL unchanged and preserve ADR 31 formula"
metrics:
  duration: "~10 minutes"
  completed: "2026-06-05"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 2
---

# Phase 3 Plan 03: FrontierScheduler Skill-Matching Extension Summary

Opt-in GIN-based skill routing layered on top of the existing FrontierSchedulerWorker priority dispatch loop. Tasks declaring `required_skills[]` in their payload are now gated on a live agent_registry check before being marked `pending_dispatch`; tasks without `required_skills` continue through the original path unchanged.

## What Was Built

`SKILL_MATCH_SQL` — a new exported SQL constant that runs `SELECT 1 FROM agent_registry WHERE status='active' AND skills && $1::text[] AND last_heartbeat > NOW() - ($2 || ' seconds')::interval LIMIT 1`. This is the D-1 dispatch gate: it uses the GIN index (`idx_agent_registry_skills` from migration 007) for O(log N) overlap matching and excludes stale agents via the `AGENT_HEARTBEAT_TTL_S` window.

`FRONTIER_PRIORITY_SQL` — extended its `SELECT` projection to return `payload` (TEXT per ADR 02) so `onFrontierChanged` can parse `required_skills`. The `WHERE`, `ORDER BY`, `LIMIT`, and all score arithmetic are byte-for-byte unchanged (ADR 31 invariant).

`onFrontierChanged` — updated dispatch loop: after the Top-K SQL returns candidate rows, the method partitions them into passthrough (no `required_skills`) and skill-gated rows. Skill-gated rows only join `eligibleIds` when `SKILL_MATCH_SQL` returns a match row. The final `DISPATCH_SQL` runs only on `eligibleIds`. A D-1 guard logs and strips `assigned_agent_id`/`preferred_agent` if they appear in any task payload.

## TDD Gate Compliance

1. RED commit `31264e2` — replaced `it.todo()` stubs with real failing assertions for GATE4-5a/b/c plus `SKILL_MATCH_SQL` structural tests. All 6 new tests confirmed failing before implementation.
2. GREEN commit `0d75453` — implementation makes all 7 tests pass. All 19 Phase 1 frontier tests unchanged and passing. Full suite: 146 pass, 32 skipped (DB integration).

## Commits

| Hash | Type | Description |
|------|------|-------------|
| `31264e2` | test(03-03) | GATE4-5 skill-match dispatch tests (RED) |
| `0d75453` | feat(03-03) | FrontierScheduler skill-matching via agent_registry GIN && |

## Deviations from Plan

None — plan executed exactly as written.

The implementation follows the plan's action spec precisely:
- `payload` added to `FRONTIER_PRIORITY_SQL` SELECT only (WHERE/ORDER/score unchanged)
- Per-row `SKILL_MATCH_SQL` check inserted between Top-K selection and `DISPATCH_SQL`
- `AGENT_HEARTBEAT_TTL_S` from shared constants — not hardcoded
- D-1 guard: `assigned_agent_id`/`preferred_agent` logged and stripped, never routed on
- Opt-in confirmed: tasks without `required_skills` never touch `agent_registry`

## Known Stubs

None. The skill-matching filter is fully wired; `SKILL_MATCH_SQL` is live on the dispatch path. The `agent_registry` table itself is populated by Plan 03-05 (`register_agent` MCP tool), but the filter is correct and functional — it simply returns no match until agents register.

## Threat Surface Scan

No new network endpoints or auth paths introduced. `SKILL_MATCH_SQL` binds `$1::text[]`, so malformed `required_skills` (non-array coerced to array) cannot inject SQL (T-03-03-02 mitigated). The D-1 guard fulfills T-03-03-01. T-03-03-03 (no capable agent → task never dispatches) is the accepted behavior per Watchdog TTL backstop.

## Self-Check: PASSED

- `packages/workers/src/scheduler/frontier.worker.ts` — exists, modified
- `packages/workers/src/scheduler/frontier.test.ts` — exists, modified
- Commit `31264e2` — verified in git log
- Commit `0d75453` — verified in git log
- `grep -c "skills &&" packages/workers/src/scheduler/frontier.worker.ts` → 1
- All 7 GATE4-5 tests: GREEN
- All 19 Phase 1 frontier tests: GREEN
- `npm run typecheck` → exit 0
- Full vitest suite: 146 pass, 32 skipped (no regressions)
