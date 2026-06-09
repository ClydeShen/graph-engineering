import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { writeGuard, occWrite } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';
import type { TrailReader } from '../base/trail-reader.js';

export const SEMANTIC_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::semantic',
  config: { topic: 'graph::scope::closed' },
} as const;

export class SemanticMemoryWorker {
  private readonly reader: TrailReader;
  private readonly pool: Pool;
  private readonly llm: LLMProvider;

  constructor(reader: TrailReader, pool: Pool, llm: LLMProvider) {
    this.reader = reader;
    this.pool = pool;
    this.llm = llm;
  }

  async onScopeClosed(scopeId: string, entityId: string, predecessorHash: string): Promise<void> {
    const records = await this.reader.getEpisodicRecords(scopeId, { limit: 50 });
    if (records.length === 0) return;

    const combined = records.join('\n');
    // LLM CALL — ADR 22 (distillation from episodic to semantic; cannot be deterministic)
    const fact = await this.llm.chat([
      { role: 'system', content: 'Distill the following execution traces into key facts. Be concise.' },
      { role: 'user', content: writeGuard(combined) },
    ]);

    await this.pool.query(
      `INSERT INTO semantic_memory (scope_id, content, valid_from, created_at)
       VALUES ($1, $2, NOW(), NOW())`,
      [scopeId, writeGuard(fact)],
    );

    const contentHash = createHash('sha256').update(fact).digest('hex');
    // Phase 1 constraint C1 — every memory write must trace to execution_event_log
    await occWrite(this.pool, {
      scopeId,
      entityId,
      predecessorHash,
      payload: { memory_type: 'semantic', content_hash: contentHash },
      eventType: 'memory_updated',
    });
  }
}
