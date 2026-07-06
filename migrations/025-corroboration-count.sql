-- Migration 025: topology-corroboration admission control (GH #30-#35 → prevention lever).
--
-- N7 settled that retirement has a structural ceiling: retire → cold-start →
-- re-crystallize just re-rolls the same crystallization lottery, so it can restore
-- the base convergence rate but never beat it. The only lever that beats baseline
-- LOADS the lottery: don't recall a runbook at full weight until it has proven it is
-- not a one-off — i.e. until its topology has been INDEPENDENTLY RE-DERIVED.
--
-- corroboration_count tracks exactly that: each time a new converged scope
-- crystallizes a runbook whose WL topology matches an existing one (findMergeable),
-- the consolidated canonical's corroboration_count is incremented. Recall can then
-- gate on corroboration_count >= recallPromoteThreshold (config; default 0 = no gate
-- = current behaviour). A clean topology re-derived by every clean run is promoted
-- fast; a one-off stumbled runbook is never re-derived → never promoted → never
-- recalled → cannot trap the loop into collapse.
--
-- This breaks the promotion<->recall deadlock: corroboration comes from independent
-- COLD-START re-derivation, not from recall-success. Same mutable-counter family as
-- success_count; no append-only impact.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS corroboration_count INT NOT NULL DEFAULT 0;

-- End of migration 025 — topology-corroboration admission control (prevention).
