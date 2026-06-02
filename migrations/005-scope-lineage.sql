-- Migration 005: scope_lineage — cold metadata table
--
-- scope_lineage is NOT an event log and NOT append-only.
-- It is a mutable cold metadata table written during the 3-phase DDL nesting protocol
-- by the Control Plane's exclusive DDL connection (ADR 05, ADR 23).
--
-- Purpose: tracks the Scope hierarchy tree — parent/child relationships, depth, and
-- operational status. The depth CHECK (depth <= 3) enforces MAX_CHILD_SCOPE_DEPTH = 3
-- at the database level (ADR 34 D-7 subagent branching constraint).
--
-- This table is NOT partitioned — it has far fewer rows than execution_event_log
-- (one row per Scope vs. many events per Scope) and needs to support arbitrary
-- WHERE queries for Watchdog convergence checks (ADR 19).
--
-- Written during DDL nesting protocol Phase 2 (after CREATE PARTITION succeeds,
-- before INSERT plan_created event). This ordering ensures scope_lineage always
-- has an entry for any Scope that has events (ADR 05).

CREATE TABLE IF NOT EXISTS scope_lineage (
    -- Primary key: the Scope UUID being described
    scope_id        UUID        PRIMARY KEY,
    -- Parent scope_id for sub-scopes created via spawned_by hyperedge (ADR 34).
    -- NULL for top-level scopes (depth = 0).
    parent_scope_id UUID,
    -- Nesting depth from the root scope (0 = top-level, max 3 per ADR 34 D-7).
    -- CHECK constraint enforces MAX_CHILD_SCOPE_DEPTH at the database level.
    depth           INT         NOT NULL DEFAULT 0 CHECK (depth <= 3),
    -- Human-readable intent description provided at scope creation time.
    intent          TEXT,
    -- Operational status of this scope ('active', 'converged', 'closed').
    -- Mutable: updated by the Convergence Watchdog when scope_closed is emitted (ADR 19).
    -- NOT append-only — this is intentional (cold metadata, not event log).
    status          TEXT        DEFAULT 'active',
    -- Creation timestamp (immutable after insert)
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Index for Watchdog convergence checks: quickly find all active child scopes
-- of a given parent (needed for nested scope propagation ADR 23).
CREATE INDEX IF NOT EXISTS idx_scope_lineage_parent
    ON scope_lineage (parent_scope_id)
    WHERE parent_scope_id IS NOT NULL;

-- Index for status queries: Watchdog checks for all active scopes during convergence
CREATE INDEX IF NOT EXISTS idx_scope_lineage_status
    ON scope_lineage (status);
