/**
 * EmbeddingBackfillWorker — drains the embedding_backlog (ADR 55 D-2).
 *
 * The semantic index is a late projection of the graph: rows written during an
 * embedding outage carry NULL embeddings plus a backlog entry. This worker
 * recomputes them once the endpoint recovers. Content-addressed targets make
 * every recompute idempotent — re-running over an already-filled cell is a
 * harmless overwrite with the same input text.
 *
 * Cron cadence: every 5 minutes (cheap no-op when the backlog is empty or the
 * provider is still down — the first failed embed aborts the run).
 */

import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { logger, LOG_EVENTS } from '@shared/logger';

export const EMBEDDING_BACKFILL_TRIGGER = {
  type: 'cron' as const,
  function_id: 'graph::memory::embedding-backfill',
  config: { expression: '0 */5 * * * * *' },
} as const;

/**
 * Code-side allowlist: target_table/target_column are CHECK-constrained in the
 * DB, but identifiers cannot be parameterized — resolve them through this map,
 * never by interpolating row values.
 */
const TARGETS: Record<string, Record<string, string>> = {
  semantic_memory: { embedding: 'UPDATE semantic_memory SET embedding = $1::vector WHERE id = $2' },
  episodic_memory: { embedding: 'UPDATE episodic_memory SET embedding = $1::vector WHERE id = $2' },
  procedural_memory: {
    intent_embedding: 'UPDATE procedural_memory SET intent_embedding = $1::vector WHERE id = $2',
  },
};

interface BacklogRow {
  id: string;
  target_table: string;
  target_id: string;
  target_column: string;
  content: string;
}

export class EmbeddingBackfillWorker {
  constructor(
    private readonly pool: Pool,
    private readonly embed: EmbeddingProvider | null,
  ) {}

  /** Drain up to `batchSize` backlog rows. Returns counts for observability. */
  async drain(batchSize = 50): Promise<{ filled: number; skipped: number; aborted: boolean }> {
    if (this.embed === null) {
      // No provider configured — nothing to drain into; stay degraded.
      return { filled: 0, skipped: 0, aborted: false };
    }
    const { rows } = await this.pool.query<BacklogRow>(
      `SELECT id, target_table, target_id, target_column, content
       FROM embedding_backlog
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize],
    );

    let filled = 0;
    let skipped = 0;
    for (const row of rows) {
      const updateSql = TARGETS[row.target_table]?.[row.target_column];
      if (updateSql === undefined) {
        // Unknown target (should be impossible under the CHECK constraint) —
        // drop the row rather than retry forever.
        await this.pool.query(`DELETE FROM embedding_backlog WHERE id = $1`, [row.id]);
        skipped++;
        continue;
      }
      try {
        // LLM CALL — ADR 22 (embedding; not counted against Worker token budget)
        const { vector } = await this.embed.embed(row.content);
        await this.pool.query(updateSql, ['[' + vector.join(',') + ']', row.target_id]);
        await this.pool.query(`DELETE FROM embedding_backlog WHERE id = $1`, [row.id]);
        filled++;
      } catch (err) {
        // Endpoint still down (or this row failed) — record and abort the run;
        // the next cron tick retries from the oldest row.
        await this.pool.query(
          `UPDATE embedding_backlog SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
          [row.id, err instanceof Error ? err.message.slice(0, 500) : String(err)],
        );
        logger.child({ component: 'embedding-backfill' }).warn(
          { backlog_id: row.id, filled },
          LOG_EVENTS.EMBEDDING_BACKLOG_DRAINED,
        );
        return { filled, skipped, aborted: true };
      }
    }

    if (filled > 0) {
      logger.child({ component: 'embedding-backfill' }).info(
        { filled, skipped },
        LOG_EVENTS.EMBEDDING_BACKLOG_DRAINED,
      );
    }
    return { filled, skipped, aborted: false };
  }
}
