-- Migration 018: Artifact read model (ADR-52 / Phase 19).
--
-- Artifact = deliverable work product: content lives on disk at
-- <profile>/artifacts/<sha256> (hash-addressed, Snapshot hash semantics);
-- this table is the typed-column read model (migration 002 red line:
-- payload::jsonb is forbidden, so artifact queries get columns).
--
-- Ledger linkage: producers reference content_hash in their result payloads —
-- no mid-scope infra events (they would claim the agent's OCC predecessor
-- slot, migration 013 design note).
--
-- PK (content_hash, scope_id): identical content produced in two scopes is
-- two provenance rows over one disk file; erase deletes the file only when
-- no non-erased row references the hash (ADR-43 cascade).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS artifact (
    content_hash TEXT        NOT NULL,
    scope_id     UUID        NOT NULL,
    entity_id    UUID        NOT NULL,
    kind         TEXT        NOT NULL,  -- markdown | code | html | image | binary
    media_type   TEXT        NOT NULL,
    byte_size    BIGINT      NOT NULL,
    label        TEXT        NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    erased_at    TIMESTAMPTZ NULL,
    PRIMARY KEY (content_hash, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_artifact_scope
    ON artifact (scope_id, created_at DESC);
