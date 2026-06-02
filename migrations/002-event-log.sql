-- Migration 002: execution_event_log partitioned parent table
--
-- This is the SSOT for the Execution Graph (ADR 01, ADR 04).
-- Partitioned BY LIST(scope_id) — one sub-table per Scope.
-- Each partition is created at nesting time by the Control Plane DDL connection (ADR 05).
--
-- IMPORTANT: payload column is TEXT, never JSONB.
-- Reason: canonical_json serialization is performed in TypeScript (BTreeMap-equivalent key sort)
-- before being sent to PostgreSQL as a pre-serialized TEXT literal. PostgreSQL must never
-- do a ::jsonb conversion because jsonb internally reorders keys by length-first (not alphabetic),
-- which would silently corrupt the hash preimage and break version_hash reproducibility (ADR 02).
-- Any code that performs payload::jsonb or payload::jsonb->>'field' is a critical bug.
--
-- OCC constraints (UNIQUE(predecessor_hash, scope_id) for first-writer-wins and
-- UNIQUE(scope_id, entity_id, version_hash) for idempotency) are NOT declared on the parent.
-- They are created per-partition at nesting time by the Control Plane DDL protocol (ADR 05, ADR 11).
-- This is required because PostgreSQL does not enforce unique constraints across partition boundaries.
--
-- Frontier Scheduler typed columns (base_priority, unlocks_count, spawned_by, last_active_at)
-- are stored as typed columns rather than extracted from payload::jsonb at query time,
-- ensuring the priority SQL formula runs without any JSON cast operations (ADR 31, ADR 29).

CREATE TABLE IF NOT EXISTS execution_event_log (
    -- Surrogate key (BIGSERIAL auto-increment per partition)
    id                BIGSERIAL          NOT NULL,

    -- Logical event identifier (application-assigned, may be NULL for legacy rows)
    event_id          BIGINT,

    -- Partition key: each Scope gets its own partition sub-table
    scope_id          UUID               NOT NULL,

    -- Stable Entity UUID — tracks business object identity across versions (ADR 02)
    entity_id         UUID               NOT NULL,

    -- One of the five canonical event types only (ADR 12).
    -- Additional types are rejected at the bus level before reaching the DB.
    event_type        TEXT               NOT NULL
                          CHECK (event_type IN (
                              'plan_created',
                              'task_spawned',
                              'memory_updated',
                              'conflict_detected',
                              'scope_closed'
                          )),

    -- SHA-256 hash of the prior version, forming the append-only causal chain (ADR 02).
    -- For plan_created root nodes, this is ZERO_HASH (64 zeros).
    predecessor_hash  TEXT               NOT NULL,

    -- SHA-256 hash of this version, computed by pgcrypto digest() inside a Writable CTE (ADR 02).
    -- Formula: digest(scope_id||'|'||entity_id||'|'||predecessor_hash||'|'||event_type||'|'||canonical_json_text, 'sha256')
    version_hash      TEXT               NOT NULL,

    -- Pre-serialized canonical JSON TEXT from the application layer (ADR 02).
    -- MUST be TEXT. MUST NOT be JSONB. See header comment for rationale.
    payload           TEXT               NOT NULL,

    -- Scheduling lifecycle status for the Queue Adapter (ADR 32)
    status            TEXT               NOT NULL DEFAULT 'pending_scheduling',

    -- Timestamp when this event was dispatched to a Worker (NULL = not yet dispatched)
    dispatched_at     TIMESTAMPTZ,

    -- Immutable creation timestamp
    created_at        TIMESTAMPTZ        NOT NULL DEFAULT NOW(),

    -- Frontier Scheduler typed column: base priority score (default 1 = lowest, used by Pattern Discovery; ADR 31)
    base_priority     INT                NOT NULL DEFAULT 1,

    -- Frontier Scheduler typed column: number of downstream tasks unlocked by this event.
    -- Used in dynamic_score formula: unlocks_count × 5 (ADR 31, ADR 29 §Frontier formula).
    unlocks_count     INT                NOT NULL DEFAULT 0,

    -- Frontier Scheduler typed column: parent scope_id if this event was spawned by a sub-scope.
    -- Used for spawned_by_bonus(3) in the priority formula (ADR 31, ADR 34).
    spawned_by        UUID,

    -- Frontier Scheduler typed column: last heartbeat timestamp from the Control Plane.
    -- Used for active_bonus(15) — events whose scope has recent activity are prioritised (ADR 31).
    last_active_at    TIMESTAMPTZ,

    -- Composite primary key must include the partition key (PostgreSQL requirement for LIST partitions)
    PRIMARY KEY (scope_id, id)

) PARTITION BY LIST (scope_id);
