import type { Pool } from 'pg';
import { MIN_CORPUS_THRESHOLD } from '@shared/constants.js';

// MUST NOT subscribe to scope_completed inline and MUST NOT acquire OLTP worker slots.
// This worker runs only on the 6-hour cron schedule at lowest priority (base_priority = 1).
// Registration is owned by Plan 09 index.ts. See ADR 37 D-10.
export const PATTERN_DISCOVERY_CRON_TRIGGER = {
  type: 'cron' as const,
  function_id: 'graph::patterns::discover',
  config: { expression: '0 0 */6 * * * *' },
};

export class PatternDiscoveryWorker {
  readonly base_priority = 1;

  async runDiscovery(pool: Pool): Promise<{ skipped: boolean }> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM scope_lineage WHERE status = 'closed'`
    );
    const count = Number(rows[0]?.count ?? 0);

    if (count < MIN_CORPUS_THRESHOLD) {
      // Cold-start graceful degradation — system runs as single-session agent
      // until corpus accumulates. Full WL-kernel pattern extraction is Phase 3.
      return { skipped: true };
    }

    // Phase 1 stub body — full WL-kernel pattern extraction is Phase 3.
    return { skipped: false };
  }
}
