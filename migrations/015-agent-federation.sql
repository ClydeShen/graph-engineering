-- Migration 015: agent federation (ADR-46 / Phase 13).
--   - memory visibility domains (agent-private / shared / global) + owner
--   - agent_registry.trust_level (TRUST_LEVELS enum from @graph/types/core)
--   - principal_alias: queryable projection for cross-channel identity (same_as)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.
-- DEFAULT 'global' backfills existing rows — current retrieval behavior unchanged.

ALTER TABLE episodic_memory
    ADD COLUMN IF NOT EXISTS visibility      TEXT NOT NULL DEFAULT 'global',
    ADD COLUMN IF NOT EXISTS owner_principal TEXT NULL;

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS visibility      TEXT NOT NULL DEFAULT 'global',
    ADD COLUMN IF NOT EXISTS owner_principal TEXT NULL;

ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS visibility      TEXT NOT NULL DEFAULT 'global',
    ADD COLUMN IF NOT EXISTS owner_principal TEXT NULL;

-- Trust classification for multi-candidate ranking (ADR-46 D-2) and the
-- Phase 14 trust→toolset mapping. Values: 'untrusted' | 'paired' | 'trusted'.
ALTER TABLE agent_registry
    ADD COLUMN IF NOT EXISTS trust_level TEXT NOT NULL DEFAULT 'paired';

-- Cross-channel identity projection (ADR-46 D-5). The graph carries the
-- memex::identity::same_as audit events; this table is the O(1) lookup face.
CREATE TABLE IF NOT EXISTS principal_alias (
    alias     TEXT        PRIMARY KEY,   -- e.g. 'telegram:12345678'
    principal TEXT        NOT NULL,      -- e.g. 'user:alice'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_principal_alias_principal
    ON principal_alias (principal);
