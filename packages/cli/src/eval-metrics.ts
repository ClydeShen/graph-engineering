/**
 * Memex quality metrics (Phase 16 G3) — "越用越聪明" must be measurable.
 *
 * Three dimensions (16-PHASE-SPEC §2b):
 *   1. Trail Discovery hit rate   — success_count / injection_count (Phase 10 loop)
 *   2. Lesson retention           — reinforcement distribution + superseded ratio
 *   3. Knapsack compression       — computed from a live context assembly response
 *                                   (tokens are not persisted; the journey samples them)
 *
 * Snapshot comparison is the release regression gate: metrics must not degrade
 * beyond tolerance between releases (ADR-49).
 */

export type MetricsQuery = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

export interface HitRateMetric {
  injections: number;
  successes: number;
  /** null when nothing was ever injected — no signal, not a zero score. */
  hitRate: number | null;
}

export async function trailDiscoveryHitRate(query: MetricsQuery): Promise<HitRateMetric> {
  const { rows } = await query(
    `SELECT COALESCE(SUM(injection_count), 0)::int AS injections,
            COALESCE(SUM(success_count), 0)::int  AS successes
     FROM procedural_memory
     WHERE injection_count > 0`,
  );
  const injections = Number(rows[0]?.['injections'] ?? 0);
  const successes = Number(rows[0]?.['successes'] ?? 0);
  return { injections, successes, hitRate: injections > 0 ? successes / injections : null };
}

export interface RetentionMetric {
  totalLessons: number;
  reinforcedLessons: number;
  /** Share of lessons that survived (not superseded by decay/supersession). */
  retentionRatio: number | null;
  avgReinforcement: number;
}

export async function lessonRetention(query: MetricsQuery): Promise<RetentionMetric> {
  // Lessons live in procedural_memory — that's where the Ebbinghaus columns are
  // (reinforcement_count migration 006, confidence migration 011).
  const { rows } = await query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE reinforcement_count > 0)::int AS reinforced,
            COUNT(*) FILTER (WHERE superseded_by IS NULL)::int   AS surviving,
            COALESCE(AVG(reinforcement_count), 0)::float          AS avg_reinforcement
     FROM procedural_memory`,
  );
  const total = Number(rows[0]?.['total'] ?? 0);
  return {
    totalLessons: total,
    reinforcedLessons: Number(rows[0]?.['reinforced'] ?? 0),
    retentionRatio: total > 0 ? Number(rows[0]?.['surviving'] ?? 0) / total : null,
    avgReinforcement: Number(rows[0]?.['avg_reinforcement'] ?? 0),
  };
}

export interface CompressionMetric {
  contextEvents: number;
  droppedCount: number;
  ccrCount: number;
  /** Share of candidate events the knapsack kept. null when nothing competed. */
  keptRatio: number | null;
}

/** Pure: computed from a gateway context-assembly response (journey samples it). */
export function knapsackCompression(context: {
  context: unknown[];
  droppedCount: number;
  ccrHashes: unknown[];
}): CompressionMetric {
  const kept = context.context.length;
  const total = kept + context.droppedCount;
  return {
    contextEvents: kept,
    droppedCount: context.droppedCount,
    ccrCount: context.ccrHashes.length,
    keptRatio: total > 0 ? kept / total : null,
  };
}

// ── Release regression gate (ADR-49) ─────────────────────────────────────────

export interface EvalSnapshot {
  taken_at: string;
  hit_rate: HitRateMetric;
  retention: RetentionMetric;
  compression: CompressionMetric | null;
}

export async function takeSnapshot(
  query: MetricsQuery,
  compression: CompressionMetric | null = null,
  now: Date = new Date(),
): Promise<EvalSnapshot> {
  return {
    taken_at: now.toISOString(),
    hit_rate: await trailDiscoveryHitRate(query),
    retention: await lessonRetention(query),
    compression,
  };
}

/** Tolerated absolute drop per ratio metric before the gate trips. */
export const REGRESSION_TOLERANCE = 0.05;

/**
 * Compare against the previous release snapshot. A metric that was null before
 * (no signal yet) never trips the gate — the gate guards degradation, it does
 * not demand growth.
 */
export function compareSnapshots(prev: EvalSnapshot, curr: EvalSnapshot): string[] {
  const regressions: string[] = [];
  const check = (label: string, before: number | null, after: number | null) => {
    if (before === null || after === null) return;
    if (after < before - REGRESSION_TOLERANCE) {
      regressions.push(`${label} regressed: ${before.toFixed(3)} → ${after.toFixed(3)}`);
    }
  };
  check('trail-discovery hit rate', prev.hit_rate.hitRate, curr.hit_rate.hitRate);
  check('lesson retention ratio', prev.retention.retentionRatio, curr.retention.retentionRatio);
  check(
    'knapsack kept ratio',
    prev.compression?.keptRatio ?? null,
    curr.compression?.keptRatio ?? null,
  );
  return regressions;
}
