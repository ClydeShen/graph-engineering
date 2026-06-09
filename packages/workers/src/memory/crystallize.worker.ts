import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { writeGuard, occWrite, notify } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';
import type { TrailReader } from '../base/trail-reader.js';
import type { MemoryRepository } from '../base/memory-repository.js';

export const CRYSTALLIZE_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::crystallize',
  config: { topic: 'graph::scope::closed' },
} as const;

export class CrystallizeWorker {
  constructor(
    private readonly reader: TrailReader,
    private readonly memory: MemoryRepository,
    private readonly pool: Pool,
    private readonly llm: LLMProvider,
    private readonly sdk: { trigger(opts: { function_id: string; payload: unknown; action?: unknown }): Promise<unknown> },
  ) {}

  async onScopeClosed(
    scopeId: string,
    entityId: string,
    predecessorHash: string,
  ): Promise<{ skipped: true } | { written: true }> {
    const records = await this.reader.getEpisodicRecords(scopeId);
    if (records.length === 0) return { skipped: true };

    const combined = records.join('\n');
    const fingerprintId = createHash('sha256').update(combined).digest('hex');

    const existingLesson = await this.memory.lookupLesson(fingerprintId);
    const existing = existingLesson?.content ?? null;

    // LLM CALL — ADR 22 (delta crystallization; injects existing lesson to avoid full rewrite)
    const llmOutput = await this.llm.chat([
      {
        role: 'system',
        content: existing
          ? 'You are refining an existing lesson. Output ONLY the delta — what changed or was added. Do not repeat unchanged content.'
          : 'Distill these execution traces into a concise Crystal: key insight, pattern, and recommendation. Be brief.',
      },
      {
        role: 'user',
        content: existing
          ? writeGuard(`EXISTING LESSON:\n${existing}\n\nNEW TRAIL EVENTS:\n${combined}`)
          : writeGuard(combined),
      },
    ]);

    await occWrite(this.pool, {
      scopeId,
      entityId,
      predecessorHash,
      payload: { crystal: llmOutput, source: 'crystallize', scope_id: scopeId },
      eventType: 'memory_updated',
    });

    await notify({ type: 'crystal', scope_id: scopeId, summary: llmOutput.slice(0, 200) });

    await this.sdk.trigger({
      function_id: 'graph::memory::lesson-save',
      payload: { content: llmOutput, confidence: 0.6 },
    });

    return { written: true };
  }
}
