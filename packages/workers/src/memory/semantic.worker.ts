import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { writeGuard, occWrite } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';

export const SEMANTIC_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::semantic',
  config: { topic: 'graph::scope::closed' },
} as const;

export class SemanticMemoryWorker {
  private readonly pool: Pool;
  private readonly llm: LLMProvider;

  constructor(pool: Pool, llm: LLMProvider) {
    this.pool = pool;
    this.llm = llm;
  }

  async onScopeClosed(scopeId: string, entityId: string, predecessorHash: string): Promise<void> {
    const { rows } = await this.pool.query<{ content: string }>(
      `SELECT content FROM episodic_memory WHERE scope_id = $1 ORDER BY created_at ASC LIMIT 50`,
      [scopeId],
    );
    if (rows.length === 0) return;

    const combined = rows.map((r) => r.content).join('\n');
    // LLM CALL — ADR 22 (distillation from episodic to semantic; cannot be deterministic)
    const fact = await this.llm.chat([
      { role: 'system', content: 'Distill the following execution traces into key facts. Be concise.' },
      { role: 'user', content: writeGuard(combined) },
    ]);

    await this.pool.query(
      `INSERT INTO semantic_memory (scope_id, content, created_at)
       VALUES ($1, $2, NOW())`,
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
