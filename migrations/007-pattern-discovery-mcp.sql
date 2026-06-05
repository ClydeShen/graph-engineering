-- Migration 007: Phase 3 pattern discovery + MCP bridging schema
--
-- Two sections:
--   1. agent_registry table — skill-based task routing (D-1, D-2, DESIGN.md §3.2)
--   2. procedural_memory extensions — intent_embedding + cross_domain_cluster_id
--      for CrossScopePatternDiscoveryWorker (ADR 25, ADR 37)
--
-- All CREATE TABLE/INDEX statements use IF NOT EXISTS — idempotent.
-- All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS — safe to re-run.
-- No Phase 1 or Phase 2 data is altered or deleted.
--
-- Requires: migrations 001-006 applied (pgvector, pgcrypto, procedural_memory table).

-- ── agent_registry ────────────────────────────────────────────────────────────
-- Stores registered agents (internal Workers and external MCP/A2A agents).
-- All participants declare their accepted skills here; FrontierScheduler queries
-- this table for skill-based dispatch (D-1: task dispatch sovereignty in Frontier).
--
-- protocol CHECK constraint: 'mcp' | 'a2a' | 'iii' (D-3: three protocols coexist).
-- status CHECK constraint: 'active' | 'inactive'.
-- agent_card_json JSONB: full A2A-compatible AgentCard for external protocol negotiation.
-- last_heartbeat: updated by live agents; FrontierScheduler excludes agents where
--   NOW() - last_heartbeat > AGENT_HEARTBEAT_TTL_S (60s, see shared constants).

CREATE TABLE IF NOT EXISTS agent_registry (
    agent_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT        NOT NULL,
    description     TEXT,
    skills          TEXT[]      NOT NULL DEFAULT '{}',
    protocol        TEXT        NOT NULL CHECK (protocol IN ('mcp', 'a2a', 'iii')),
    endpoint        TEXT,
    agent_card_json JSONB       NOT NULL,
    registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_heartbeat  TIMESTAMPTZ,
    status          TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

-- GIN index for TEXT[] skill matching — enables `skills && $1::text[]` overlap queries.
-- Required for FrontierScheduler Plan 03-03 skill-match dispatch (D-1).
CREATE INDEX IF NOT EXISTS idx_agent_registry_skills
    ON agent_registry USING GIN (skills);

-- Partial index for active-agent heartbeat queries.
-- WHERE status = 'active' keeps the index small — inactive agents are never queried for dispatch.
-- Covers: SELECT ... WHERE status='active' AND last_heartbeat > NOW() - INTERVAL '60 seconds'
CREATE INDEX IF NOT EXISTS idx_agent_registry_status_heartbeat
    ON agent_registry (status, last_heartbeat)
    WHERE status = 'active';

-- ── procedural_memory extensions ─────────────────────────────────────────────
-- intent_embedding: 1536-dim OpenAI-compatible semantic embedding of intent_description.
-- Populated by ProceduralMemoryWorker.onSynthesizerOutput (Plan 03-01 Task 2).
-- Used by CrossScopePatternDiscoveryWorker (Plan 03-02) as the cross-domain guard:
--   intent_embedding <=> b.intent_embedding > 0.50  (semantically different intents)
-- Dimension 1536 matches semantic_memory.embedding (migration 003) — same provider call.
--
-- cross_domain_cluster_id: UUID assigned by CrossScopePatternDiscoveryWorker when a
-- template is grouped with topologically-equivalent cross-domain templates (ADR 25).
-- Update is idempotent: CrossScopePatternDiscoveryWorker uses WHERE cross_domain_cluster_id IS NULL.
--
-- Note: topology_embedding vector(128) already exists from migration 003 — NOT re-declared here.

ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS intent_embedding       vector(1536),
    ADD COLUMN IF NOT EXISTS cross_domain_cluster_id UUID;

-- B-tree index for cluster-membership lookups (find all templates in a cluster).
-- Partial index WHERE NOT NULL keeps index small — most rows are unclustered initially.
-- NO HNSW index on intent_embedding: cross-domain query uses topology_embedding HNSW
-- first (ORDER BY topology_embedding <=> $1 LIMIT 50), then filters by intent distance
-- on the small candidate set. A separate HNSW on intent_embedding would slow INSERTs
-- without materially benefiting the two-pass ANN query (RESEARCH.md Pitfall 1).
CREATE INDEX IF NOT EXISTS idx_procedural_cross_domain_cluster
    ON procedural_memory (cross_domain_cluster_id)
    WHERE cross_domain_cluster_id IS NOT NULL;

-- intent_embedding is nullable for pre-Phase-3 rows (those rows predate this column).
-- CrossScopePatternDiscoveryWorker skips rows where intent_embedding IS NULL per its
-- WHERE clause: WHERE intent_embedding IS NOT NULL AND topology_embedding IS NOT NULL.

-- End of migration 007 — unlocks Phase 3 Plan 03-02 (CrossScopePatternDiscovery)
-- and Plan 03-03 (FrontierScheduler skill-matching).
