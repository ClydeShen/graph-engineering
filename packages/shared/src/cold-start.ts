/**
 * isScopeColdStart() — shared cold_start signal for the Reflection Track (D-10, ADR-21).
 *
 * "cold_start" means the first turn of a Scope. episodic_memory rows are only written
 * by TemplateProposalWorker.onScopeClosed (D-01), so they cannot be used to detect the
 * first turn of an open scope (CR-01, 09-REVIEW.md). Instead, count rows in
 * execution_event_log for scopeId: the just-written current event makes "1" mean
 * "first turn".
 *
 * Used by both the Gateway (process-agent-turn.ts) and the Worker pipeline
 * (assemble.ts opts.memReflect.isColdStart) so the two cold_start checks cannot drift
 * (WR-01, 09-REVIEW.md).
 *
 * @see ADR 21 (mem::reflect trigger spec)
 */

import type { Pool } from 'pg';

export async function isScopeColdStart(pool: Pool, scopeId: string): Promise<boolean> {
  const { rows } = await pool.query<{ cnt: string }>(
    'SELECT COUNT(*)::text AS cnt FROM execution_event_log WHERE scope_id = $1',
    [scopeId],
  );
  return (rows[0]?.cnt ?? '0') === '1';
}
