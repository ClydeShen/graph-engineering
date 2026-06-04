-- Migration 006: Phase 2 memory schema extensions
--
-- Adds columns and indexes that were deliberately deferred from migration 003
-- (Phase 1 stub) and are required by Phase 2 memory workers and retrieval queries.
--
-- All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS — safe to re-run.
-- All CREATE INDEX statements use IF NOT EXISTS — idempotent.
-- No Phase 1 data is altered or deleted.
--
-- ts_doc dictionary: Migration 003 uses to_tsvector('english', ...) for column generation.
-- BM25 queries in Phase 2 use plainto_tsquery('english', ...) to match the stored tsvector.
-- The ADR 20 supplement specified 'simple' to preserve technical terms; however, changing
-- GENERATED ALWAYS columns requires DROP+ADD which destroys the GIN index. Accepted tradeoff:
-- 'english' stemming may normalize technical terms but the GIN index remains intact.
-- Decision: use plainto_tsquery('english', ...) in all Phase 2 BM25 search queries.

-- ── episodic_memory ──────────────────────────────────────────────────────────
-- entity_id: links episodic records back to the entity in execution_event_log.
-- Nullable — no FK constraint because scopes may close before entity exists in event log.
-- intent_summary / outcome_summary: optional distillation fields written by SemanticMemoryWorker.

ALTER TABLE episodic_memory
    ADD COLUMN IF NOT EXISTS entity_id        UUID,
    ADD COLUMN IF NOT EXISTS intent_summary   TEXT,
    ADD COLUMN IF NOT EXISTS outcome_summary  TEXT;

-- ── semantic_memory ──────────────────────────────────────────────────────────
-- superseded_by: self-referential UUID for logical-delete pattern.
-- When superseded_by = id, the record is considered expired / replaced.
-- Nullable — most records are active (not superseded).

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS superseded_by UUID;

-- HNSW index on semantic_memory.embedding (deferred from migration 003, ADR 22).
-- m=16, ef_construction=64 per ADR 25 specification.
-- Cosine distance (vector_cosine_ops) for OpenAI-compatible embedding similarity.
-- Partial index WHERE embedding IS NOT NULL prevents indexing NULL vectors (RESEARCH.md Pitfall 5).
CREATE INDEX IF NOT EXISTS idx_semantic_memory_embedding_hnsw
    ON semantic_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;

-- ── procedural_memory ────────────────────────────────────────────────────────
-- Reinforcement tracking columns (ADR 20 Task 1, Ebbinghaus decay G3-6):
--   success_count / failure_count: incremented by ProceduralMemoryWorker on feedback events.
--   reinforcement_count: checked by MemorySynthesizerWorker decay query (>= 3 threshold).
--   last_used_at: 90-day Ebbinghaus decay window — records unused for 90+ days are superseded.
--   superseded_by: nullable; logical-delete pattern (superseded_by = id marks decay).
-- Note: quality_score and is_anti_pattern already exist in migration 003 — not added here.

ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS success_count       INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failure_count       INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS reinforcement_count INT         NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_used_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS superseded_by       UUID;

-- ── working_memory ───────────────────────────────────────────────────────────
-- dedup_hash: SHA-256 fingerprint for 5-minute dedup window (ADR 20 working_memory).
-- Nullable — existing Phase 1 rows have no hash; new inserts always provide one.

ALTER TABLE working_memory
    ADD COLUMN IF NOT EXISTS dedup_hash TEXT;

-- Partial unique index: enforces uniqueness only when dedup_hash IS NOT NULL.
-- This ensures pre-existing NULL rows from Phase 1 do not violate the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_working_memory_dedup
    ON working_memory (scope_id, dedup_hash)
    WHERE dedup_hash IS NOT NULL;

-- End of migration 006 — enables Phase 2 memory workers (02-02 through 02-07).
