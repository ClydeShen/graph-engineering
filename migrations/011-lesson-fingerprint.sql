-- Migration 011: procedural_memory lesson deduplication columns
--
-- Adds fingerprint_id (SHA-256 of content) and confidence (Ebbinghaus score) to
-- procedural_memory for LessonSaveWorker (Phase 4, T4).
--
-- fingerprint_id TEXT: content-addressed dedup key; unique where NOT NULL.
-- confidence FLOAT: Ebbinghaus reinforcement score (0.0–1.0), default 0.5.
--
-- Both use ADD COLUMN IF NOT EXISTS — safe to re-run.

ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS fingerprint_id TEXT,
    ADD COLUMN IF NOT EXISTS confidence      FLOAT NOT NULL DEFAULT 0.5;

CREATE UNIQUE INDEX IF NOT EXISTS idx_procedural_memory_fingerprint_id
    ON procedural_memory (fingerprint_id)
    WHERE fingerprint_id IS NOT NULL;
