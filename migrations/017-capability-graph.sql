-- Migration 017: Capability Graph read models (ADR-51 / Phase 18).
--
-- The ledger (capability:registry scope events) is the semantic authority for
-- capability history; these tables are the typed-column read models — the
-- house "metrics live in columns + join tables, never payload::jsonb" pattern
-- (migration 002 red line, migration 013 precedent).
--
--   capability_binding     — CURRENT category→implementation binding
--                            (history = memex::capability::bound ledger events)
--   capability_activation  — co-occurrence rows: implementation X was active
--                            in scope Y. Outcome attribution joins
--                            scope_lineage at query time (ADR-51 D-6 v1:
--                            co-occurrence counting; switch-pair strong
--                            samples land in Phase 20).
--
-- Join-table not ledger-event design note: mid-scope infra events would claim
-- the agent's OCC predecessor slot (ADR 41) — same rationale as migration 013.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS capability_binding (
    category       TEXT        PRIMARY KEY,
    implementation TEXT        NOT NULL,
    bound_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS capability_activation (
    scope_id       UUID        NOT NULL,
    implementation TEXT        NOT NULL,
    activated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_id, implementation)
);

-- Ranking query path: per-implementation aggregates joined with scope outcome.
CREATE INDEX IF NOT EXISTS idx_capability_activation_impl
    ON capability_activation (implementation, activated_at DESC);
