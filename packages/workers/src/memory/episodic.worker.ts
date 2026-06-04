import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { writeGuard, occWrite } from '@graph/shared';

export const EPISODIC_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::episodic',
  config: { topic: 'graph::memory::episodic::ingest' },
} as const;

export class EpisodicMemoryWorker {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async onEvent(
    scopeId: string,
    entityId: string,
    content: string,
    predecessorHash: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO episodic_memory (scope_id, entity_id, content, created_at)
       VALUES ($1, $2, $3, NOW())`,
      [scopeId, entityId, writeGuard(content)],
    );

    const contentHash = createHash('sha256').update(content).digest('hex');
    // Phase 1 constraint C1 — every memory write must trace to execution_event_log
    await occWrite(this.pool, {
      scopeId,
      entityId,
      predecessorHash,
      payload: { memory_type: 'episodic', content_hash: contentHash },
      eventType: 'memory_updated',
    });
  }
}
