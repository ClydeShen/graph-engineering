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
 * Check whether a Scope is currently suspended (ADR 39 lockout).
 *
 * Called at the top of processAgentTurn before any write attempt.
 * Returns true when scope_lineage.status = 'suspended'.
 *
 * @param pool     SELECT pool (read-only access required)
 * @param scopeId  The scope to check
 */
export async function checkSuspended(pool: Pool, scopeId: string): Promise<boolean> {
  const result = await pool.query<{ status: string }>(
    'SELECT status FROM scope_lineage WHERE scope_id = $1',
    [scopeId],
  );
  return result.rows[0]?.status === 'suspended';
}

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
 * Append an infrastructure event to the scope's Association chain and update scope_lineage.
 *
 * Shared implementation for all Gateway infra-write rights (ADR 24). The version_hash
 * computation follows the standard formula: scope_id|entity_id|predecessor_hash|event_type|payload.
 * Public functions are thin wrappers that name their intent; the SQL invariant lives here once.
 */
async function writeInfraEvent(
  pool: Pool,
  scopeId: string,
  eventType: string,
  canonicalPayload: string,
  scopeStatus: string,
): Promise<void> {
  const entityId = randomUUID();

  await pool.query(
    `INSERT INTO execution_event_log
       (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
     SELECT
       $1::uuid,
       $2::uuid,
       $3,
       version_hash,
       encode(
         digest(
           $1::text || '|' || $2::text || '|' || version_hash
             || '|' || $3 || '|' || $4,
           'sha256'
         ),
         'hex'
       ),
       $4,
       $5
     FROM execution_event_log
     WHERE scope_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [scopeId, entityId, eventType, canonicalPayload, scopeStatus],
  );

  await pool.query(
    `UPDATE scope_lineage SET status = $2 WHERE scope_id = $1`,
    [scopeId, scopeStatus === 'terminated' ? 'closed' : scopeStatus],
  );
}

/**
 * Write a scope_closed event directly to execution_event_log.
 *
 * Gateway infra-write right #1: scope_closed (ADR 24).
 * This is called only when checkConvergence() returns both flags true.
 */
export async function writeScopeClosed(pool: Pool, scopeId: string): Promise<void> {
  await writeInfraEvent(pool, scopeId, 'scope_closed', canonicalJson({ scope_id: scopeId }), 'terminated');
}

/**
 * Write a context_oom_throttled event and suspend the scope.
 *
 * Gateway infra-write right #2: context_oom_throttled (ADR 24).
 * Called when assembleContext() reports OOM (Tier 3 of Context OOM degradation chain).
 */
export async function writeContextOomThrottled(pool: Pool, scopeId: string): Promise<void> {
  await writeInfraEvent(
    pool,
    scopeId,
    'memory_updated',
    canonicalJson({ scope_id: scopeId, reason: 'context_oom_throttled' }),
    'suspended',
  );
}
