import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { writeGuard, occWrite } from '@graph/shared';
import type { EmbeddingProvider } from '@graph/shared';
import { computeWLEmbedding } from './wl-embedding.js';
import type { MemoryRepository } from '../base/memory-repository.js';

export const PROCEDURAL_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::procedural',
  config: { topic: 'graph::memory::synthesizer::output' },
} as const;

export class ProceduralMemoryWorker {
  constructor(
    private readonly memory: MemoryRepository,
    private readonly pool: Pool,
    private readonly llm: EmbeddingProvider,
  ) {}

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

    // LLM CALL — ADR 22 (embedding calls excluded from Worker token budget)
    // intent_embedding is the semantic embedding of the intent_description (1536-dim).
    // Distinct from topology_embedding (WL kernel output, 128-dim) — used by
    // CrossScopePatternDiscoveryWorker as the cross-domain guard (ADR 25).
    // Falls back to NULL on provider failure; topology_embedding write is unaffected.
    let intentEmbeddingLiteral: string | null = null;
    try {
      const result = await this.llm.embed(intentDescription);
      if (result.vector.length > 0) {
        intentEmbeddingLiteral = `[${result.vector.join(',')}]`;
      }
    } catch {
      // Embedding failure — write NULL for intent_embedding; topology write still proceeds
    }

    await this.memory.insertProceduralTemplate({
      scopeId,
      content: writeGuard(intentDescription),
      intentDescription: writeGuard(intentDescription),
      templateGraph,
      embeddingLiteral,
      intentEmbeddingLiteral,
    });

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
    await this.memory.reinforceTemplate(templateId);
  }
}
