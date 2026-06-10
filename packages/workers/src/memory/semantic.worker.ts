import { writeGuard, contentFingerprint } from '@graph/shared';
import type { EventWriter, LLMProvider } from '@graph/shared';
import type { TrailReader } from '../base/trail-reader.js';
import type { MemoryRepository } from '../base/memory-repository.js';

export const SEMANTIC_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::semantic',
  config: { topic: 'graph::scope::closed' },
} as const;

export class SemanticMemoryWorker {
  constructor(
    private readonly reader: TrailReader,
    private readonly memory: MemoryRepository,
    private readonly writes: EventWriter,
    private readonly llm: LLMProvider,
  ) {}

  async onScopeClosed(scopeId: string, entityId: string, predecessorHash: string): Promise<void> {
    const records = await this.reader.getEpisodicRecords(scopeId, { limit: 50 });
    if (records.length === 0) return;

    const combined = records.join('\n');
    // LLM CALL — ADR 22 (distillation from episodic to semantic; cannot be deterministic)
    const fact = await this.llm.chat([
      { role: 'system', content: 'Distill the following execution traces into key facts. Be concise.' },
      { role: 'user', content: writeGuard(combined) },
    ]);

    await this.memory.insertSemanticFact(scopeId, writeGuard(fact));

    const contentHash = contentFingerprint(fact);
    // Phase 1 constraint C1 — every memory write must trace to execution_event_log
    await this.writes.write({
      scopeId,
      entityId,
      predecessorHash,
      payload: { memory_type: 'semantic', content_hash: contentHash },
      eventType: 'memory_updated',
    });
  }
}
