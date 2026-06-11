-- Migration 014: agent_pairing persistence (TD-G, ADR-44 D-4).
-- Pairing state survives gateway restarts. The in-memory Map remains the hot
-- cache (warmed at boot via warmPairingCache); all mutations write through.
-- Cross-replica consistency is deferred to Phase 15 (shared-store semantics
-- land with the remote Gateway work).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS agent_pairing (
    agent_id          TEXT        PRIMARY KEY,
    -- salted SHA-256 of the pairing code — plaintext codes are never stored
    code_hash         TEXT        NOT NULL,
    salt              TEXT        NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- generation rate limit anchor: 1 code / agent / 10 min
    last_generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    failed_attempts   INT         NOT NULL DEFAULT 0,
    paired            BOOLEAN     NOT NULL DEFAULT FALSE
);
