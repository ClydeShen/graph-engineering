import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { writeGuard, occWrite } from '@graph/shared';
import type { MemoryRepository } from '../base/memory-repository.js';

export const EPISODIC_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::episodic',
  config: { topic: 'graph::memory::episodic::ingest' },
} as const;

export class EpisodicMemoryWorker {
  constructor(
    private readonly memory: MemoryRepository,
    private readonly pool: Pool,
  ) {}

  async onEvent(
    scopeId: string,
    entityId: string,
    content: string,
    predecessorHash: string,
  ): Promise<void> {
    await this.memory.appendEpisodicTrace(scopeId, entityId, writeGuard(content));

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
