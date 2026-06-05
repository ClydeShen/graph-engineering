-- Migration 009: scope_lineage_view — materialized traversal cache
--
-- Pre-computes the full event set per scope as a materialized view, enabling
-- Knapsack Slicing predecessor-chain lookups without a linear full-table scan
-- on the execution_event_log partitions (Issue #9, ADR 05 perf).
--
-- Design:
--   - PostgreSQL MATERIALIZED VIEW over execution_event_log (all partitions)
--   - Refreshed CONCURRENTLY after scope convergence (non-blocking)
--   - Unique index on (scope_id, id) required for REFRESH CONCURRENTLY
--   - Gateway scope-read route tries this view first; falls back to direct table
--     query if the view is stale or unavailable (correctness over speed, AC3)
--   - Phase 1 composite index idx_scope_{id}_pending_lookup is NOT removed (AC4)
--
-- Refresh cadence:
--   The Control Plane Daemon calls
--     REFRESH MATERIALIZED VIEW CONCURRENTLY scope_lineage_view
--   as a non-blocking fire-and-forget after each scope_closed event.
--   Query readers that arrive before the refresh complete transparently read
--   the previous snapshot (CONCURRENTLY does not block reads).
--
-- Note: For Scope depths <= 50 tasks the Phase 1 composite index on the
-- partition is sufficient. This view becomes effective beyond that threshold.

CREATE MATERIALIZED VIEW IF NOT EXISTS scope_lineage_view AS
SELECT
    id,
    scope_id,
    entity_id,
    event_type,
    predecessor_hash,
    version_hash,
    payload,
    status,
    base_priority,
    unlocks_count,
    spawned_by,
    last_active_at,
    created_at
FROM execution_event_log;

-- Unique index: required for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_scope_lineage_view_pk
    ON scope_lineage_view (scope_id, id);

-- Index for scope_id range scans (primary access pattern from scope-read route)
CREATE INDEX IF NOT EXISTS idx_scope_lineage_view_scope
    ON scope_lineage_view (scope_id, created_at ASC);

-- Index for hash-based lookups (Knapsack getEventByHash traversal)
CREATE INDEX IF NOT EXISTS idx_scope_lineage_view_hash
    ON scope_lineage_view (version_hash);

-- End of migration 009 — enables scope_lineage_view as traversal cache.
-- Refresh: REFRESH MATERIALIZED VIEW CONCURRENTLY scope_lineage_view
