import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { writeGuard, occWrite } from '@graph/shared';
import { computeWLEmbedding } from './wl-embedding.js';

export const PROCEDURAL_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::procedural',
  config: { topic: 'graph::memory::synthesizer::output' },
} as const;

export class ProceduralMemoryWorker {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async onSynthesizerOutput(
    scopeId: string,
    entityId: string,
    predecessorHash: string,
    templateGraph: unknown,
    intentDescription: string,
    nodes: { id: string; event_type: string }[],
    edges: { source: string; target: string }[],
  ): Promise<void> {
    const embedding = computeWLEmbedding(nodes, edges);
    // HNSW guard: topology_embedding must NEVER be NULL at INSERT time (Pitfall 5)
    const embeddingLiteral = `[${Array.from(embedding).join(',')}]`;

    await this.pool.query(
      `INSERT INTO procedural_memory
         (scope_id, content, intent_description, template_graph, topology_embedding,
          success_count, reinforcement_count, last_used_at, created_at)
       VALUES ($1, $2, $3, $4, $5, 0, 0, NOW(), NOW())`,
      [
        scopeId,
        writeGuard(intentDescription),
        intentDescription,
        JSON.stringify(templateGraph),
        embeddingLiteral,
      ],
    );

    const contentHash = createHash('sha256').update(intentDescription).digest('hex');
    // Phase 1 constraint C1 — every memory write must trace to execution_event_log
    await occWrite(this.pool, {
      scopeId,
      entityId,
      predecessorHash,
      payload: { memory_type: 'procedural', content_hash: contentHash },
      eventType: 'memory_updated',
    });
  }

  async reinforce(templateId: string): Promise<void> {
    await this.pool.query(
      `UPDATE procedural_memory
       SET success_count = success_count + 1,
           last_used_at = NOW()
       WHERE id = $1`,
      [templateId],
    );
  }
}
