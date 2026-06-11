import { writeGuard, contentFingerprint } from '@graph/shared';
import type { EventWriter, LLMProvider, EmbeddingProvider } from '@graph/shared';
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
    private readonly embed: EmbeddingProvider,
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

    // LLM CALL — ADR 22 (embedding calls not counted against Worker token budget)
    const { vector } = await this.embed.embed(writeGuard(fact));
    const guardedFact = writeGuard(fact);
    const { id, suggestedMerge } = await this.memory.insertSemanticFact(scopeId, guardedFact, vector);

    if (suggestedMerge !== null) {
      // Refinement path: >0.89 similarity — same fact restated, supersede (D-08).
      await this.memory.supersede(suggestedMerge.id, id);
    } else {
      // Contradiction path (Phase 10): 0.70–0.89 band — about the same thing but
      // not a restatement. An LLM binary judgement decides whether the old fact
      // is factually contradicted; only then does supersession fire. The LLM call
      // is gated on a band hit, so it costs nothing on the common no-candidate path.
      const candidate = await this.memory.findContradictionCandidate(vector, id);
      if (candidate !== null) {
        // LLM CALL — ADR 22 (contradiction judgement; gated on 0.70–0.89 band hit)
        const verdict = await this.llm.chat([
          {
            role: 'system',
            content:
              'Two knowledge-base statements follow. Decide if they factually contradict ' +
              'each other (cannot both be true). Answer with exactly one word: ' +
              'CONTRADICT or COMPATIBLE.',
          },
          { role: 'user', content: `A:\n${candidate.content}\n\nB:\n${guardedFact}` },
        ]);
        if (verdict.trim().toUpperCase().startsWith('CONTRADICT')) {
          await this.memory.supersede(candidate.id, id);
        }
      }
    }

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
