import { writeGuard, contentFingerprint } from '@graph/shared';
import type { EventWriter, LLMProvider, EmbeddingProvider } from '@graph/shared';
import type { EventLogNode } from '@graph/shared';
import type { TrailReader } from '../base/trail-reader.js';
import type { MemoryRepository } from '../base/memory-repository.js';

export const TEMPLATE_PROPOSAL_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::template-proposal',
  config: { topic: 'graph::scope::closed' },
} as const;

export class TemplateProposalWorker {
  /**
   * Zero-vector placeholder for topology_embedding on orphan anti-pattern writes.
   * WL kernel not available in Phase 9; Phase 10 backfills real embeddings.
   */
  private static readonly ZERO_TOPOLOGY_EMBEDDING =
    '[' + Array(128).fill(0).join(',') + ']';

  constructor(
    private readonly reader: TrailReader,
    private readonly memory: MemoryRepository,
    private readonly writes: EventWriter,
    private readonly llm: LLMProvider,
    private readonly embed: EmbeddingProvider,
  ) {}

  /**
   * Detect entity_ids in the scope that have no successor events — orphan (terminal) nodes.
   *
   * An entity is an orphan if its version_hash never appears as a predecessor_hash in any
   * event within the scope. These become negative samples (anti-patterns) in procedural_memory.
   */
  private detectOrphanEntityIds(events: EventLogNode[]): string[] {
    const predecessorHashes = new Set(events.map((e) => e.predecessor_hash));
    const orphans = events
      .filter((e) => e.entity_id != null && !predecessorHashes.has(e.version_hash))
      .map((e) => e.entity_id);
    return [...new Set(orphans)];
  }

  async onScopeClosed(
    scopeId: string,
    entityId: string,
    predecessorHash: string,
  ): Promise<void> {
    // Step 1: Load full Scope DAG (D-02). Return early if scope is empty.
    const events = await this.reader.getScopeEvents(scopeId);
    if (events.length === 0) return;

    // Step 2: LLM CALL — ADR 22 (intent/outcome extraction; cannot be deterministic)
    const scopeText = events.map((e) => JSON.stringify(e)).join('\n');
    const llmResponse = await this.llm.chat([
      {
        role: 'system',
        content:
          'You are analyzing an agent execution trace. Extract the primary intent and outcome. ' +
          'Return ONLY valid JSON in this format: {"intent_summary":"...","outcome_summary":"..."}. ' +
          'Be concise — each field should be one sentence.',
      },
      { role: 'user', content: writeGuard(scopeText) },
    ]);

    let intentSummary: string;
    let outcomeSummary: string;
    try {
      const parsed = JSON.parse(llmResponse) as { intent_summary: string; outcome_summary: string };
      intentSummary = parsed.intent_summary;
      outcomeSummary = parsed.outcome_summary;
    } catch {
      intentSummary = llmResponse.substring(0, 300);
      outcomeSummary = 'outcome extraction failed';
    }

    // Step 3: LLM CALL — ADR 22 (embedding calls not counted against Worker token budget)
    try {
      const { vector } = await this.embed.embed(
        writeGuard(intentSummary) + '\n' + writeGuard(outcomeSummary),
      );
      const embeddingLiteral = '[' + vector.join(',') + ']';
      await this.memory.appendEpisodicSummary(
        scopeId,
        entityId,
        writeGuard(intentSummary),
        writeGuard(outcomeSummary),
        embeddingLiteral,
      );
    } catch {
      // Embedding failure — write empty-vector episodic row rather than skip entirely.
      // HNSW index requires non-null embedding: use zero vector as fallback.
      const fallbackEmbeddingLiteral = '[' + Array(1536).fill(0).join(',') + ']';
      await this.memory.appendEpisodicSummary(
        scopeId,
        entityId,
        writeGuard(intentSummary),
        writeGuard(outcomeSummary),
        fallbackEmbeddingLiteral,
      );
    }

    // Step 4: Emit memory_updated event for episodic write (Phase 1 constraint C1)
    await this.writes.write({
      scopeId,
      entityId,
      predecessorHash,
      payload: { memory_type: 'episodic', content_hash: contentFingerprint(intentSummary) },
      eventType: 'memory_updated',
    });

    // Step 5: Orphan detection and anti-pattern writes (D-05)
    const orphanEntityIds = this.detectOrphanEntityIds(events);
    for (const orphanEntityId of orphanEntityIds) {
      try {
        await this.memory.insertProceduralTemplate({
          scopeId,
          content: writeGuard('orphan-entity:' + orphanEntityId),
          intentDescription: writeGuard(
            'Orphan node — entity ' +
              orphanEntityId +
              ' had no successor events in scope ' +
              scopeId,
          ),
          templateGraph: { orphan_entity_id: orphanEntityId, scope_id: scopeId },
          embeddingLiteral: TemplateProposalWorker.ZERO_TOPOLOGY_EMBEDDING,
          intentEmbeddingLiteral: null,
          isAntiPattern: true,
        });
        await this.writes.write({
          scopeId,
          entityId: orphanEntityId,
          predecessorHash,
          payload: {
            memory_type: 'procedural',
            content_hash: contentFingerprint('orphan:' + orphanEntityId),
            is_anti_pattern: true,
          },
          eventType: 'memory_updated',
        });
      } catch {
        /* orphan write failure must not break episodic write */
      }
    }
  }
}
