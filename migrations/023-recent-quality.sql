-- Migration 023: recency-weighted trust (GH #30-#35 → N5).
--
-- N4 falsified the freshness substrate (collapse-rate 0.55 → 0.33) but exposed a
-- residual failure mode: LATE DRIFT. A crystallization with a long history of
-- success that begins failing only at the end keeps a high CUMULATIVE Laplace
-- quality ((success+1)/(success+failure+1)), so apoptosis never retires it — the
-- loop recalls a now-stale runbook and collapses.
--
-- A crystallization's reliability is a NON-STATIONARY Bernoulli process; cumulative
-- trust is insensitive to recent degradation. The fix (research-validated against
-- non-stationary-bandit theory — discounted/sliding-window UCB is near-optimal —
-- and the agent-memory staleness literature) is a RECENCY-WEIGHTED trust signal:
-- an EWMA of recent outcomes that sinks fast when a once-good template starts
-- failing. recent_quality is in the same mutable-counter family as
-- success_count/failure_count — it does NOT touch the append-only event graph.
--
-- Neutral prior 0.5 (unproven, not yet trusted nor distrusted). Metabolism and the
-- mid-flight escalation gate read recent_quality; the recall RERANK is left on
-- cumulative quality (a validated loop asset — unchanged on purpose).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE procedural_memory
    ADD COLUMN IF NOT EXISTS recent_quality DOUBLE PRECISION NOT NULL DEFAULT 0.5;

-- End of migration 023 — N5 recency-weighted retirement (late-drift fix).
