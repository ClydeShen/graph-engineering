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
import { FRESHNESS } from './freshness-config.js';
import {
  extractStepOrder,
  parseOrderingRules,
  checkConformance,
  type ConformanceEvent,
} from './conformance.js';

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
 * Soften the templates injected into a scope that terminated WITHOUT converging
 * (GH #24 → #30). The automatic de-confounder: a scope's outcome is
 * `freshness × cooking`, and only the INGREDIENT (crystallization) is in scope.
 * So instead of the pre-#30 blind "all injected templates get failure_count+1 on
 * context-OOM", this softens PER TEMPLATE, gated on conformance:
 *
 *   - the template's prescribed "X before Y" rules were FOLLOWED, yet the scope
 *     failed → the ingredient is implicated → `failure_count += softenIncrement`;
 *   - the rules were VIOLATED (a cooking mistake, out of scope) → freshness
 *     untouched;
 *   - rules can't be judged (no applicable rule / unparseable lesson / no events)
 *     → fail closed → untouched. Cooking and ingredient cannot be told apart, so
 *     we never penalize on a guess.
 *
 * Trigger-generalized (#30): this is no longer OOM-specific — it grades any
 * non-convergent terminal given the scope id. Production's sole non-convergent
 * terminal today is the ADR-39 context-OOM suspension (caller: processAgentTurn);
 * the eval harness calls it on a TURN_CAP non-convergence too.
 *
 * Standalone pool function (like recordTemplateInjection) so callers need no
 * MemoryRepository. Best-effort and self-contained: per-template parse/compare
 * errors are swallowed (never break scope close); the OOM caller also wraps it.
 */
export async function penalizeInjectedTemplates(
  pool: Pool,
  scopeId: string,
): Promise<{ penalized: number }> {
  const { rows: injected } = await pool.query<{ id: string; content: string | null }>(
    `SELECT pm.id, pm.content
     FROM template_injection ti
     JOIN procedural_memory pm ON pm.id = ti.template_id
     WHERE ti.scope_id = $1`,
    [scopeId],
  );
  if (injected.length === 0) return { penalized: 0 };

  const { rows: events } = await pool.query<ConformanceEvent>(
    `SELECT event_type, payload FROM execution_event_log WHERE scope_id = $1 ORDER BY id ASC`,
    [scopeId],
  );
  const actualOrder = extractStepOrder(events);
  const vocab = [...new Set(actualOrder)];

  const conformedIds: string[] = [];
  for (const t of injected) {
    try {
      const rules = parseOrderingRules(t.content ?? '', vocab);
      const verdict = checkConformance(rules, actualOrder, FRESHNESS.conformanceMaxViolationRatio);
      if (verdict === 'conformed') conformedIds.push(t.id); // ingredient followed but failed
    } catch {
      /* fail closed — an unjudgeable template is never softened */
    }
  }
  if (conformedIds.length === 0) return { penalized: 0 };

  await pool.query(
    // N5: also discount recent_quality toward 0 (EWMA, outcome=0) so a once-good
    // template that starts failing loses recency-weighted trust fast (late-drift).
    `UPDATE procedural_memory
     SET failure_count = failure_count + $2,
         recent_quality = (1.0 - $3) * recent_quality,
         last_used_at = NOW()
     WHERE id = ANY($1::uuid[])`,
    [conformedIds, FRESHNESS.softenIncrement, FRESHNESS.recencyAlpha],
  );
  return { penalized: conformedIds.length };
}
