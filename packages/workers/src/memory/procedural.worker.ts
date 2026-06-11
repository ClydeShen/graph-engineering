import { writeGuard, contentFingerprint } from '@graph/shared';
import type { EventWriter, EmbeddingProvider } from '@graph/shared';
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
    private readonly writes: EventWriter,
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

    const contentHash = contentFingerprint(intentDescription);
    // Phase 1 constraint C1 — every memory write must trace to execution_event_log
    await this.writes.write({
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
