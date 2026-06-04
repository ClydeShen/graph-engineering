/**
 * Inline Watchdog SQL for the HTTP Gateway.
 *
 * The Gateway runs Tier 3 convergence SQL inline on every POST /v1/scopes/:id/events
 * request. If the scope is converged (pending_tasks=0 AND no open conflicts), the
 * Gateway directly writes scope_closed — this is the Gateway's authorised infra-write
 * right per ADR 24.
 *
 * Gateway holds infra-write rights for:
 *   - scope_closed  (via this inline Watchdog SQL path)
 *   - context_oom_throttled  (via handleContextOom)
 *
 * Gateway does NOT hold DDL rights — those stay with the Control Plane Daemon.
 *
 * @see ADR 19 — Convergence Watchdog (Tier 3 SQL)
 * @see ADR 24 — Gateway direct-write rights for infra events
 * @see ADR 28 — Scheduling spec and operational determinism
 */

import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { canonicalJson } from '@graph/shared';

/**
 * Tier 3 convergence SQL — identical to the Control Plane Watchdog's Tier 3.
 * Runs inline on every event POST inside the same request context.
 *
 * Source: ADR 19 / RESEARCH.md §Convergence Watchdog SQL
 */
export const INLINE_WATCHDOG_SQL = `
  SELECT
    NOT EXISTS (
      SELECT 1 FROM execution_event_log
      WHERE scope_id = $1
        AND status NOT IN ('terminated', 'archived')
        AND event_type NOT IN ('scope_closed', 'conflict_detected')
    ) AS is_converged,
    NOT EXISTS (
      SELECT 1 FROM execution_event_log
      WHERE scope_id = $1
        AND event_type = 'conflict_detected'
        AND status != 'resolved'
    ) AS no_open_conflicts
`;

export interface ConvergenceResult {
  isConverged: boolean;
  noOpenConflicts: boolean;
}

/**
 * Execute the inline convergence check against the given pool.
 * Returns the convergence state without making any writes.
 *
 * @param pool     SELECT/INSERT pool (no DDL rights required)
 * @param scopeId  The scope to check
 */
export async function checkConvergence(
  pool: Pool,
  scopeId: string,
): Promise<ConvergenceResult> {
  const result = await pool.query<{
    is_converged: boolean;
    no_open_conflicts: boolean;
  }>(INLINE_WATCHDOG_SQL, [scopeId]);

  const row = result.rows[0];
  return {
    isConverged: row?.is_converged ?? false,
    noOpenConflicts: row?.no_open_conflicts ?? true,
  };
}

/**
 * Write a scope_closed event directly to execution_event_log.
 *
 * Gateway infra-write right #1: scope_closed (ADR 24).
 * This is called only when checkConvergence() returns both flags true.
 *
 * @param pool     SELECT/INSERT pool
 * @param scopeId  The scope being closed
 */
export async function writeScopeClosed(
  pool: Pool,
  scopeId: string,
): Promise<void> {
  const entityId = randomUUID();
  const canonicalPayload = canonicalJson({ scope_id: scopeId });

  await pool.query(
    `INSERT INTO execution_event_log
       (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
     SELECT
       $1::uuid,
       $2::uuid,
       'scope_closed',
       version_hash,
       encode(
         digest(
           $1::text || '|' || $2::text || '|' || version_hash
             || '|scope_closed|' || $3,
           'sha256'
         ),
         'hex'
       ),
       $3,
       'terminated'
     FROM execution_event_log
     WHERE scope_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [scopeId, entityId, canonicalPayload],
  );

  // Mark scope_lineage closed
  await pool.query(
    `UPDATE scope_lineage SET status = 'closed' WHERE scope_id = $1`,
    [scopeId],
  );
}

/**
 * Write a context_oom_throttled event and suspend the scope.
 *
 * Gateway infra-write right #2: context_oom_throttled (ADR 24).
 * Called when assembleContext() reports OOM (Tier 3 of Context OOM degradation chain).
 *
 * @param pool     SELECT/INSERT pool
 * @param scopeId  The scope experiencing OOM
 */
export async function writeContextOomThrottled(
  pool: Pool,
  scopeId: string,
): Promise<void> {
  const entityId = randomUUID();
  const canonicalPayload = canonicalJson({
    scope_id: scopeId,
    reason: 'context_oom_throttled',
  });

  await pool.query(
    `INSERT INTO execution_event_log
       (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
     SELECT
       $1::uuid,
       $2::uuid,
       'memory_updated',
       version_hash,
       encode(
         digest(
           $1::text || '|' || $2::text || '|' || version_hash
             || '|memory_updated|' || $3,
           'sha256'
         ),
         'hex'
       ),
       $3,
       'suspended'
     FROM execution_event_log
     WHERE scope_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [scopeId, entityId, canonicalPayload],
  );

  await pool.query(
    `UPDATE scope_lineage SET status = 'suspended' WHERE scope_id = $1`,
    [scopeId],
  );
}
