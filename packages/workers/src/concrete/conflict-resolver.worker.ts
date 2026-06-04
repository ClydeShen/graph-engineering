import { writeGuard } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';

const ActiveResolverRegistry = new Map<string, boolean>();

export class ConflictResolverWorker {
  private readonly llm: LLMProvider;

  constructor(llm: LLMProvider) {
    this.llm = llm;
  }

  async onConflict(
    entityId: string,
    payloadA: string,
    payloadB: string,
  ): Promise<{ merged: string } | { skipped: true }> {
    if (ActiveResolverRegistry.get(entityId)) return { skipped: true };
    ActiveResolverRegistry.set(entityId, true);
    try {
      // LLM CALL — ADR 22 (semantic conflict resolution; deterministic merge is insufficient)
      const merged = await this.llm.chat([
        { role: 'system', content: 'Merge the two conflicting payloads into one. Be concise.' },
        { role: 'user', content: `Payload A: ${writeGuard(payloadA)}\nPayload B: ${writeGuard(payloadB)}` },
      ]);
      return { merged };
    } finally {
      ActiveResolverRegistry.delete(entityId);
    }
  }
}
