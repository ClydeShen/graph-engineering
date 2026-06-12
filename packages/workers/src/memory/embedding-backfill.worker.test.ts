import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { EmbeddingBackfillWorker } from './embedding-backfill.worker.js';

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function makePool(backlogRows: unknown[]): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockImplementation(((sql: string) => {
    if (sql.includes('FROM embedding_backlog')) return Promise.resolve({ rows: backlogRows });
    return Promise.resolve({ rows: [] });
  }) as QueryFn);
  return { pool: { query } as unknown as Pool, query };
}

function makeEmbed(fail = false): EmbeddingProvider {
  return {
    embed: fail
      ? vi.fn().mockRejectedValue(new Error('fetch failed'))
      : vi.fn().mockResolvedValue({ vector: [0.1, 0.2], countedAgainstBudget: false }),
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: '1',
  target_table: 'semantic_memory',
  target_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  target_column: 'embedding',
  content: 'some fact',
  ...over,
});

describe('EmbeddingBackfillWorker (ADR 55 D-2)', () => {
  it('null provider is a no-op (still degraded)', async () => {
    const { pool, query } = makePool([row()]);
    const worker = new EmbeddingBackfillWorker(pool, null);
    expect(await worker.drain()).toEqual({ filled: 0, skipped: 0, aborted: false });
    expect(query).not.toHaveBeenCalled();
  });

  it('fills the target cell and deletes the backlog row', async () => {
    const { pool, query } = makePool([row()]);
    const worker = new EmbeddingBackfillWorker(pool, makeEmbed());
    expect(await worker.drain()).toEqual({ filled: 1, skipped: 0, aborted: false });
    const sqls = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((s: string) => s.includes('UPDATE semantic_memory SET embedding'))).toBe(true);
    expect(sqls.some((s: string) => s.includes('DELETE FROM embedding_backlog'))).toBe(true);
  });

  it('endpoint still down: records the attempt and aborts the run', async () => {
    const { pool, query } = makePool([row(), row({ id: '2' })]);
    const worker = new EmbeddingBackfillWorker(pool, makeEmbed(true));
    expect(await worker.drain()).toEqual({ filled: 0, skipped: 0, aborted: true });
    const sqls = query.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(sqls.some((s: string) => s.includes('attempts = attempts + 1'))).toBe(true);
    // aborted after first failure — no UPDATE on the target table
    expect(sqls.some((s: string) => s.includes('UPDATE semantic_memory'))).toBe(false);
  });

  it('unknown target (defensive) is dropped, not retried forever', async () => {
    const { pool } = makePool([row({ target_table: 'semantic_memory', target_column: 'intent_embedding' })]);
    const worker = new EmbeddingBackfillWorker(pool, makeEmbed());
    expect(await worker.drain()).toEqual({ filled: 0, skipped: 1, aborted: false });
  });
});
