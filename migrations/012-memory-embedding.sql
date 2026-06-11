-- Migration 012: episodic embedding column + negative procedural HNSW index.
-- Enables Phase 09 TemplateProposalWorker (D-04) and dual HNSW anti-pattern retrieval (D-13).
--
-- All ALTER TABLE statements use ADD COLUMN IF NOT EXISTS — idempotent, safe to re-run.
-- All CREATE INDEX statements use IF NOT EXISTS — idempotent.
-- No data alteration or deletion.
--
-- Requires: pgvector extension (001-extensions.sql must run first).
-- Requires: memory tables (003-memory-tables.sql, 006-memory-extensions.sql).

-- ── Section 1: episodic_memory embedding (D-04) ──────────────────────────────
--
-- Add embedding vector(1536) column so TemplateProposalWorker can write
-- LLM-generated intent+outcome embeddings inline with each episodic row.
-- Every new episodic row written by TPW will have a non-NULL embedding;
-- older rows from Phase 1/2 remain NULL until backfilled (not required for Phase 09).

ALTER TABLE episodic_memory
    ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for episodic embedding similarity search (ADR 21, D-04).
-- Partial index: only indexes rows where embedding IS NOT NULL.
-- m=16, ef_construction=64 per ADR 20/25 specification.
-- Cosine similarity (vector_cosine_ops) for OpenAI-compatible embedding distance.
CREATE INDEX IF NOT EXISTS idx_episodic_memory_embedding_hnsw
    ON episodic_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE embedding IS NOT NULL;

-- ── Section 2: procedural_memory negative HNSW (D-13) ───────────────────────
--
-- Add a partial HNSW index restricted to anti-pattern rows.
-- Completes the dual HNSW structure on procedural_memory:
--   idx_procedural_memory_topology_hnsw         (migration 003, WHERE is_anti_pattern = FALSE)
--   idx_procedural_memory_topology_hnsw_negative (this migration, WHERE is_anti_pattern = TRUE)
-- Phase 10 queries both indexes for positive/negative pattern injection into context.

CREATE INDEX IF NOT EXISTS idx_procedural_memory_topology_hnsw_negative
    ON procedural_memory
    USING hnsw (topology_embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE is_anti_pattern = TRUE;

-- ── Section 3: ADR-43 provenance columns (D-4, all three memory tables) ─────
--
-- source_scope_id: UUID of the Scope whose distillation produced this memory row.
--   Nullable — existing rows predate ADR-43 and have no source scope.
--   New inserts via PoolMemoryRepository always populate this column.
--
-- erased_at: timestamp set by the future erase(scope) workflow (Phase 14).
--   NULL means "not erased". Only set when crypto-shredding removes the payload.
--   Phase 09 writes always leave erased_at NULL.

-- episodic_memory provenance
ALTER TABLE episodic_memory
    ADD COLUMN IF NOT EXISTS source_scope_id UUID,
    ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ NULL;

-- semantic_memory provenance
ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS source_scope_id UUID,
    ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ NULL;

-- procedural_memory provenance
ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS source_scope_id UUID,
    ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ NULL;

-- End of migration 012 — enables Phase 09 TemplateProposalWorker (D-04),
-- dual HNSW anti-pattern retrieval (D-13), and ADR-43 payload erasure provenance (ADR-43-D4).
