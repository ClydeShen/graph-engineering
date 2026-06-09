import type { Pool } from 'pg';
import { writeGuard } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';

export const FUNCTION_ID = 'graph::conflict-resolver' as const;

export class ConflictResolverWorker {
  constructor(
    private readonly llm: LLMProvider,
    private readonly pool: Pool,
  ) {}

  async onConflict(
    entityId: string,
    payloadA: string,
    payloadB: string,
  ): Promise<{ merged: string } | { skipped: true }> {
    const { rows } = await this.pool.query<{ pg_try_advisory_lock: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)::bigint)',
      [entityId],
    );
    if (!rows[0].pg_try_advisory_lock) return { skipped: true };
    try {
      // LLM CALL — ADR 22 (semantic conflict resolution; deterministic merge is insufficient)
      const merged = await this.llm.chat([
        { role: 'system', content: 'Merge the two conflicting payloads into one. Be concise.' },
        { role: 'user', content: `Payload A: ${writeGuard(payloadA)}\nPayload B: ${writeGuard(payloadB)}` },
      ]);
      return { merged };
    } finally {
      await this.pool.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [entityId]);
    }
  }
}
