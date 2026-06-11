-- Migration 013: Trail Discovery closure — template injection tracking + adoption counters.
-- Phase 10 (trail-discovery). Enables the reinforcement loop:
--   reflect injects template → template_injection row + injection_count++
--   scope closes converged  → TemplateProposalWorker reads injections → success_count++
-- Hit rate (Phase 16 eval metric) = sum(success_count) / sum(injection_count).
--
-- Design note: injection records live in a join table, NOT as ledger events.
-- Writing mid-scope infra events into execution_event_log would claim the agent's
-- OCC predecessor slot and demote the agent's next write to conflict_detected
-- (see ADR 41 — OCC slot uniqueness is (predecessor_hash, scope_id)).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS.

-- Adoption counter denominator: how many times this template was injected into a scope.
ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS injection_count INT NOT NULL DEFAULT 0;

-- Per-scope injection log. PRIMARY KEY gives idempotency (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS template_injection (
    scope_id     UUID        NOT NULL,
    template_id  UUID        NOT NULL,
    trigger_type TEXT        NOT NULL,
    injected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (scope_id, template_id)
);

CREATE INDEX IF NOT EXISTS idx_template_injection_scope
    ON template_injection (scope_id);

-- End of migration 013 — Phase 10 reinforcement closure (P1-D call path) + injection metrics.
