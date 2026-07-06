-- Migration 024: outcome-streak circuit-breaker (GH #30-#35 → "lever 2", from N6).
--
-- N6 showed the conformance-gated substrate does NOT robustly cut the collapse-rate,
-- for two reasons the logs made explicit: (1) retirement is LAGGED — by the time
-- enough conformed-failures accumulate, the curve has already collapsed; (2)
-- COOKING-caused collapse (the model fails to follow an otherwise-correct runbook →
-- conformance=violated → soften correctly does NOT fire) is out of scope for the
-- trust signal, yet still traps the loop into recalling the same runbook every run.
--
-- This adds a SECOND retirement trigger that is OUTCOME-based and conformance-
-- INDEPENDENT: recall_fail_streak counts consecutive non-convergent scopes that
-- recalled a template, reset on any convergent recall. When it reaches a threshold
-- the template is retired (reversible logical-delete) so the loop cold-starts and
-- gets a fresh chance — regardless of whether the failure was ingredient or cooking.
--
-- This deliberately does NOT touch the trust signal (recent_quality stays
-- conformance-honest — we never BLAME the ingredient for a cooking mistake). The
-- streak is a pragmatic, reversible CIRCUIT-BREAKER, not a trust verdict: "this
-- ingredient, in this model's hands, reliably precedes collapse, so stop offering
-- it for now." Same mutable-counter family as success_count; no append-only impact.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS recall_fail_streak INT NOT NULL DEFAULT 0;

-- End of migration 024 — outcome-streak circuit-breaker (lever 2).
