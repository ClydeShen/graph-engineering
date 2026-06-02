-- Migration 003: Four memory tables
--
-- Four memory tables serve as the Agent's long-term and working memory stores.
-- Each table gets a ts_doc tsvector GENERATED ALWAYS column for BM25 full-text
-- search preparation (Phase 2 — schema columns only in Phase 1, ADR 20).
--
-- procedural_memory additionally receives a topology_embedding vector(128) column
-- for Weisfeiler-Lehman kernel cross-domain pattern discovery (Phase 3 stub, ADR 25, ADR 27).
-- The HNSW index uses m=16, ef_construction=64 per ADR 25 specification.
-- A partial index WHERE is_anti_pattern = FALSE excludes anti-pattern entries from
-- similarity searches (we want to find good patterns, not repeat bad ones).
--
-- semantic_memory gets a vector(1536) column for OpenAI-compatible embedding storage
-- (Phase 2 stub — no index in Phase 1, embedding queries deferred, ADR 22).
--
-- All tables share the same base schema: UUID PK, scope_id, content TEXT, created_at.
-- Requires: pgvector extension (001-extensions.sql must run first).

-- ── episodic_memory ──────────────────────────────────────────────────────────
-- Stores concrete past event records: what happened, when, in which scope.
-- Feeds the Knapsack causal lineage projection (ADR 30).

CREATE TABLE IF NOT EXISTS episodic_memory (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id    UUID,
    content     TEXT,
    -- Full-text search vector: auto-generated from content column.
    -- Phase 2 will add BM25+RRF retrieval using this column (ADR 20 supplement).
    ts_doc      TSVECTOR    GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(content, ''))
                ) STORED,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_ts_doc
    ON episodic_memory USING GIN (ts_doc);

CREATE INDEX IF NOT EXISTS idx_episodic_memory_scope_id
    ON episodic_memory (scope_id);

-- ── semantic_memory ──────────────────────────────────────────────────────────
-- Stores distilled semantic knowledge: concepts, relationships, facts.
-- embedding vector(1536) is a Phase 2 stub for OpenAI-compatible embeddings (ADR 22).
-- No HNSW index on embedding in Phase 1 — deferred until embedding pipeline is active.

CREATE TABLE IF NOT EXISTS semantic_memory (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id    UUID,
    content     TEXT,
    -- Full-text search vector (BM25 Phase 2 preparation, ADR 20).
    ts_doc      TSVECTOR    GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(content, ''))
                ) STORED,
    -- OpenAI-compatible embedding stub (vector(1536), ADR 22).
    -- Phase 1: column exists, no index. Phase 2: HNSW index will be added.
    embedding   vector(1536),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_semantic_memory_ts_doc
    ON semantic_memory USING GIN (ts_doc);

CREATE INDEX IF NOT EXISTS idx_semantic_memory_scope_id
    ON semantic_memory (scope_id);

-- ── procedural_memory ────────────────────────────────────────────────────────
-- Stores reusable execution patterns discovered from graph topology analysis.
-- This is the primary output table of the Pattern Discovery Worker (ADR 37).
--
-- topology_embedding vector(128): Weisfeiler-Lehman kernel embedding stub (ADR 25, ADR 27).
-- The HNSW partial index (WHERE is_anti_pattern = FALSE) enables similarity search
-- over known-good patterns only — anti-patterns are stored but excluded from retrieval.
-- Phase 3 will activate the WL kernel training pipeline that populates this column.

CREATE TABLE IF NOT EXISTS procedural_memory (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id            UUID,
    content             TEXT,
    -- Full-text search vector (BM25 Phase 2 preparation, ADR 20).
    ts_doc              TSVECTOR    GENERATED ALWAYS AS (
                            to_tsvector('english', coalesce(content, ''))
                        ) STORED,
    -- Human-readable description of the intent this pattern captures.
    intent_description  TEXT,
    -- Canonical graph template in JSON (the reusable topology structure).
    template_graph      JSONB,
    -- Quality score from pattern evaluation (0.0–1.0, default 0.5 = unscored).
    quality_score       FLOAT       DEFAULT 0.5,
    -- When true, this entry is an anti-pattern (negative example for discovery).
    -- Anti-patterns are stored but excluded from similarity search via partial index.
    is_anti_pattern     BOOLEAN     DEFAULT FALSE,
    -- WL kernel topology embedding stub (Phase 3, ADR 25).
    -- 128 dimensions match the WL kernel output size specified in ADR 25.
    topology_embedding  vector(128),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_procedural_memory_ts_doc
    ON procedural_memory USING GIN (ts_doc);

CREATE INDEX IF NOT EXISTS idx_procedural_memory_scope_id
    ON procedural_memory (scope_id);

-- HNSW index for topology embedding similarity search (ADR 25).
-- Partial index: only indexes non-anti-pattern entries.
-- m=16, ef_construction=64 per ADR 25 specification.
-- Cosine similarity (vector_cosine_ops) for WL kernel embedding distance.
CREATE INDEX IF NOT EXISTS idx_procedural_memory_topology_hnsw
    ON procedural_memory
    USING hnsw (topology_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE is_anti_pattern = FALSE;

-- ── working_memory ───────────────────────────────────────────────────────────
-- Stores transient within-scope working state: current hypotheses, draft plans,
-- intermediate tool results that haven't been promoted to semantic memory yet.
-- Scoped tightly: working_memory entries expire with their Scope.

CREATE TABLE IF NOT EXISTS working_memory (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    scope_id    UUID,
    content     TEXT,
    -- Full-text search vector (BM25 Phase 2 preparation, ADR 20).
    ts_doc      TSVECTOR    GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(content, ''))
                ) STORED,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_working_memory_ts_doc
    ON working_memory USING GIN (ts_doc);

CREATE INDEX IF NOT EXISTS idx_working_memory_scope_id
    ON working_memory (scope_id);
