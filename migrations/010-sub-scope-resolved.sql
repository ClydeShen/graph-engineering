-- Migration 010: extend execution_event_log check constraint to allow sub_scope_resolved
--
-- Background: resolveSubScope() in the Control Plane writes sub_scope_resolved directly
-- to the parent partition (ADR 23 §3 — three-step torch relay). This is a Control Plane
-- direct-write that bypasses the EVENT_TYPES bus enum (ADR 12), but the DB check
-- constraint on the parent table must permit the value for the INSERT to succeed.
--
-- PostgreSQL does not support ALTER TABLE ... ALTER CONSTRAINT on a check constraint.
-- The only way to replace it is DROP CONSTRAINT + ADD CONSTRAINT in a single transaction.
-- Because execution_event_log is a partitioned table, the constraint is on the parent;
-- per-partition OCC constraints (uk_scope_occ_*, uk_scope_idem_*) are unchanged.
--
-- Idempotent: wraps the drop+add in a DO block that checks pg_constraint first.

DO $$
BEGIN
  -- Drop the old 5-value constraint if it exists
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'execution_event_log_event_type_check'
      AND conrelid = 'execution_event_log'::regclass
  ) THEN
    ALTER TABLE execution_event_log
      DROP CONSTRAINT execution_event_log_event_type_check;
  END IF;

  -- Add the updated constraint with sub_scope_resolved as the 6th permitted value
  ALTER TABLE execution_event_log
    ADD CONSTRAINT execution_event_log_event_type_check
    CHECK (event_type IN (
      'plan_created',
      'task_spawned',
      'memory_updated',
      'conflict_detected',
      'scope_closed',
      'sub_scope_resolved'
    ));
END
$$;
