/**
 * Template injection recording — write side of the reinforcement loop (migration 013).
 *
 * Called from the Gateway's processAgentTurn after mem::reflect injects procedural
 * templates into a scope's context. Standalone pool function (like working-memory.ts)
 * so the Gateway can call it without constructing a MemoryRepository.
 *
 * Idempotent: the (scope_id, template_id) PRIMARY KEY absorbs re-injection;
 * injection_count increments only for rows actually inserted.
 *
 * @see docs/adr/0050-adr25-supplement2-template-graph-schema.md D-4
 */

import type { Pool } from 'pg';

export async function recordTemplateInjection(
  pool: Pool,
  scopeId: string,
  templateIds: string[],
  triggerType: string,
): Promise<{ recorded: number }> {
  if (templateIds.length === 0) return { recorded: 0 };

  const { rows } = await pool.query<{ template_id: string }>(
    `INSERT INTO template_injection (scope_id, template_id, trigger_type)
     SELECT $1, unnest($2::uuid[]), $3
     ON CONFLICT (scope_id, template_id) DO NOTHING
     RETURNING template_id`,
    [scopeId, templateIds, triggerType],
  );

  if (rows.length > 0) {
    await pool.query(
      `UPDATE procedural_memory
       SET injection_count = injection_count + 1
       WHERE id = ANY($1::uuid[])`,
      [rows.map((r) => r.template_id)],
    );
  }

  return { recorded: rows.length };
}

/**
 * Penalize the templates injected into a scope that terminated WITHOUT
 * converging (GH #24). Symmetric to TemplateProposalWorker's converged-closure
 * reinforcement (`success_count + 1`): when a scope is suspended (ADR-39
 * context-OOM lockout — it failed to reach convergence within budget), the
 * templates that were injected into it get `failure_count + 1`.
 *
 * This closes the unfalsifiable hitRate: `eval-metrics.ts →
 * trailDiscoveryHitRate = Σsuccess_count / Σinjection_count` could only ever
 * rise because nothing wrote failure_count (CLAUDE.md §5 Proxy Signal). With a
 * negative outcome path the metric becomes non-monotonic and Popper-falsifiable.
 *
 * Standalone pool function (like recordTemplateInjection) so the Gateway can
 * call it from the suspension branch without a MemoryRepository.
 *
 * Near-idempotent by construction: once a scope is suspended, processAgentTurn's
 * checkSuspended short-circuits every later turn, so the suspension branch — and
 * thus this call — fires at most once per scope.
 */
export async function penalizeInjectedTemplates(
  pool: Pool,
  scopeId: string,
): Promise<{ penalized: number }> {
  const { rowCount } = await pool.query(
    `UPDATE procedural_memory
     SET failure_count = failure_count + 1,
         last_used_at = NOW()
     WHERE id IN (SELECT template_id FROM template_injection WHERE scope_id = $1)`,
    [scopeId],
  );
  return { penalized: rowCount ?? 0 };
}
