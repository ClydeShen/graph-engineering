-- Migration 020: embedding_backlog — late-projection queue (ADR 55 D-2)
--
-- The semantic index is a projection of the graph: when the embedding endpoint
-- is unreachable, memory rows are written with NULL embedding and a backlog row
-- is enqueued here. The EmbeddingBackfillWorker drains this table once the
-- endpoint recovers — content-addressed targets make the recompute idempotent.
--
-- target_table/target_column are CHECK-constrained to the known memory tables;
-- the drain worker additionally resolves them through a code-side allowlist
-- (never string-interpolates user data into SQL).

CREATE TABLE IF NOT EXISTS embedding_backlog (
    id            BIGSERIAL PRIMARY KEY,
    target_table  TEXT NOT NULL CHECK (
        target_table IN ('semantic_memory', 'episodic_memory', 'procedural_memory')
    ),
    target_id     UUID NOT NULL,
    target_column TEXT NOT NULL DEFAULT 'embedding' CHECK (
        target_column IN ('embedding', 'intent_embedding')
    ),
    -- The exact text to embed (the projection input, captured at write time).
    content       TEXT NOT NULL,
    attempts      INT  NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- One pending projection per target cell — re-enqueue is a no-op.
    UNIQUE (target_table, target_id, target_column)
);

-- Drain order: oldest first.
CREATE INDEX IF NOT EXISTS idx_embedding_backlog_created
    ON embedding_backlog (created_at ASC);

-- End of migration 020 — embedding late-projection backlog (ADR 55).
