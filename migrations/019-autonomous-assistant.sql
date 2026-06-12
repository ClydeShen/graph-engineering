-- Migration 019: autonomous-assistant read models (ADR-53 / Phase 20).
--
--   credential_vault — per-service encrypted credentials (ADR-43 crypto-
--                      shredding mechanism reused at service granularity:
--                      destroy the wrapped DEK row = the ciphertext is dead).
--                      Values NEVER appear in the ledger or LLM context;
--                      plaintext exists only at the tool execution boundary.
--
--   user_question    — ask_user state machine projection (generalizes the
--                      approval_request pattern from binary approve/deny to
--                      free-form Q&A). Q&A audit events live in the graph.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS credential_vault (
    service      TEXT        PRIMARY KEY,
    -- AES-256-GCM over the secret value, base64 fields.
    ciphertext   TEXT        NOT NULL,
    iv           TEXT        NOT NULL,
    auth_tag     TEXT        NOT NULL,
    -- DEK wrapped by the operator KEK (MEMEX_VAULT_KEK). NULL after shredding.
    wrapped_dek  TEXT        NULL,
    wrap_iv      TEXT        NULL,
    wrap_tag     TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    destroyed_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS user_question (
    id           UUID        PRIMARY KEY,
    scope_id     UUID        NOT NULL,
    principal    TEXT        NOT NULL,
    question     TEXT        NOT NULL,
    answer       TEXT        NULL,
    status       TEXT        NOT NULL DEFAULT 'pending',  -- pending|answered|timed_out
    asked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at  TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_user_question_pending
    ON user_question (status, asked_at) WHERE status = 'pending';
