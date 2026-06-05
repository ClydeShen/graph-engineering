-- Migration 008: semantic_memory validity interval columns
--
-- Adds valid_from / valid_until TIMESTAMPTZ columns to semantic_memory to enable
-- direct temporal range queries ("what did the system know at time T?") without
-- traversing the superseded_by chain (ADR 20 supplement, Issue #11).
--
-- Design:
--   valid_from  = created_at at insert time (set via DEFAULT NOW())
--   valid_until = successor's created_at when superseded (set by trigger below)
--   NULL valid_until = "currently active / unbounded upper bound"
--
-- Pre-existing rows (from Phase 1/2) receive valid_from = NULL (unbounded lower bound).
-- The trigger applies only to UPDATE operations that set superseded_by for the first time.
--
-- All operations use IF NOT EXISTS / OR REPLACE — safe to re-run (idempotent).

ALTER TABLE semantic_memory
    ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;

-- Index to support temporal range queries: "all facts valid at time T"
--   WHERE valid_from <= T AND (valid_until IS NULL OR valid_until > T)
CREATE INDEX IF NOT EXISTS idx_semantic_memory_valid_from
    ON semantic_memory (valid_from)
    WHERE valid_from IS NOT NULL;

-- Trigger function: when superseded_by transitions NULL → non-NULL,
-- stamp valid_until = NOW() on the row being superseded.
-- This mirrors the Graphiti validity-interval pattern for knowledge graphs.
CREATE OR REPLACE FUNCTION trg_semantic_memory_set_valid_until()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.superseded_by IS NOT NULL AND OLD.superseded_by IS NULL THEN
        NEW.valid_until := NOW();
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS semantic_memory_valid_until ON semantic_memory;
CREATE TRIGGER semantic_memory_valid_until
    BEFORE UPDATE ON semantic_memory
    FOR EACH ROW EXECUTE FUNCTION trg_semantic_memory_set_valid_until();

-- End of migration 008 — enables temporal queries on semantic_memory without
-- superseded_by chain traversal (ADR 20 supplement).
