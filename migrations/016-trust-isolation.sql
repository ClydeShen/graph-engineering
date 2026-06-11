-- Migration 016: trust isolation (ADR-47 / Phase 14).
--   - execution_event_log.erased_at  (ADR-43 D-3: erased nodes skip content
--     re-verification; chain verification unaffected)
--   - key_registry: per-Scope DEK envelope slots (encryption lands with the
--     Phase 15 backup key coupling — ADR-47 D-1)
--   - approval_request: queryable projection of the approval state machine
--     (audit events live in the graph — ADR-47 D-2/D-8)
--
-- Idempotent.

ALTER TABLE execution_event_log
    ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ NULL;

-- Multi-source Lesson redistill flag (ADR-43 D-4): set by erase(scope) when a
-- fingerprint Lesson loses one of its source scopes; cleared by the next
-- CrystallizeWorker reinforcement pass.
ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS needs_redistill BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS key_registry (
    scope_id    UUID        PRIMARY KEY,
    -- KEK-wrapped DEK (base64). NULL until the encryption increment lands.
    wrapped_dek TEXT        NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- destroyed_at IS NOT NULL == DEK destroyed (erase fired before/while
    -- encryption was active; backups older than this are documented stale).
    destroyed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS approval_request (
    id            UUID        PRIMARY KEY,
    scope_id      UUID        NOT NULL,
    principal     TEXT        NOT NULL,
    command       TEXT        NOT NULL,
    status        TEXT        NOT NULL DEFAULT 'pending',  -- pending|approved|denied|timed_out
    decision_kind TEXT        NULL,                        -- once|session|always
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at    TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_approval_request_pending
    ON approval_request (status, requested_at)
    WHERE status = 'pending';
