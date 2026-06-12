-- Migration 021: one-time unlock of pre-ADR-55 suspensions (N8 cleanup)
--
-- Before ADR 55, ANY context-assembly failure (including environment faults
-- like an unreachable embedding endpoint) triggered the ADR-39 lockout. Those
-- scopes are permanently dead under the old semantics even though nothing is
-- wrong with their data.
--
-- Safety argument: under the ADR-55 fault taxonomy, a scope whose context
-- TRULY overflows will re-suspend on its next write (assembleContext throws
-- context_length → lockout). Unlocking everything is therefore safe — genuine
-- overflows re-lock themselves; environment-fault casualties recover.
--
-- The suspension history stays fully visible in the Trail (the original
-- context_oom_throttled events are immutable); only the lineage status moves.

UPDATE scope_lineage
SET status = 'active'
WHERE status = 'suspended';

-- End of migration 021 — pre-ADR-55 suspension amnesty.
