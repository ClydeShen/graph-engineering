import { writeGuard, contentFingerprint } from '@graph/shared';
import type { EventWriter, LLMProvider, EmbeddingProvider } from '@graph/shared';
import type { EventLogNode } from '@graph/shared';
import type { TrailReader } from '../base/trail-reader.js';
import type { MemoryRepository } from '../base/memory-repository.js';
import { computeWLEmbedding } from './wl-embedding.js';
import {
  buildTemplateGraphFromEvents,
  canonicalizeTemplateGraph,
  type TemplateGraph,
} from './template-graph.js';

export const TEMPLATE_PROPOSAL_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::template-proposal',
  config: { topic: 'graph::scope::closed' },
} as const;

/**
 * Low-conflict gate for positive skeleton extraction: a scope qualifies as a
 * golden template source when conflicts are ≤10% of its events (ROADMAP Phase 10
 * "低冲突收敛路径"). The scope already converged — scope_closed implies it.
 */
const LOW_CONFLICT_RATIO = 0.1;

/** WL topology embedding as a pgvector literal for a canonical template graph. */
function wlLiteral(graph: TemplateGraph): string {
  const embedding = computeWLEmbedding(
    graph.nodes.map((n) => ({ id: n.id, event_type: n.label })),
    graph.edges.map((e) => ({ source: e.from, target: e.to })),
  );
  return '[' + Array.from(embedding).join(',') + ']';
}

export class TemplateProposalWorker {
  constructor(
    private readonly reader: TrailReader,
    private readonly memory: MemoryRepository,
    private readonly writes: EventWriter,
    private readonly llm: LLMProvider,
    private readonly embed: EmbeddingProvider,
  ) {}

  /**
   * Detect events whose version_hash never appears as a predecessor — orphan
   * (dead-end) nodes. One event per orphan entity_id. These seed the
   * success-correlation negative samples (anti-patterns).
   */
  private detectOrphanEvents(events: EventLogNode[]): EventLogNode[] {
    const predecessorHashes = new Set(events.map((e) => e.predecessor_hash));
    const seenEntities = new Set<string>();
    const orphans: EventLogNode[] = [];
    for (const e of events) {
      if (e.entity_id == null) continue;
      if (predecessorHashes.has(e.version_hash)) continue;
      if (seenEntities.has(e.entity_id)) continue;
      seenEntities.add(e.entity_id);
      orphans.push(e);
    }
    return orphans;
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
    // The intent+outcome embedding is reused as the positive template's intent_embedding
    // (one embed call serves both writes — token efficiency, ADR-25 suppl 2).
    let intentEmbeddingLiteral: string | null = null;
    try {
      const { vector } = await this.embed.embed(
        writeGuard(intentSummary) + '\n' + writeGuard(outcomeSummary),
      );
      intentEmbeddingLiteral = '[' + vector.join(',') + ']';
      await this.memory.appendEpisodicSummary(
        scopeId,
        entityId,
        writeGuard(intentSummary),
        writeGuard(outcomeSummary),
        intentEmbeddingLiteral,
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

    // Step 5 (Phase 10): positive skeleton extraction — low-conflict converged scopes only.
    // Topology is built deterministically from the event DAG (zero LLM — ADR-25 suppl 2 D-3).
    const conflictCount = events.filter((e) => e.event_type === 'conflict_detected').length;
    if (conflictCount <= events.length * LOW_CONFLICT_RATIO) {
      try {
        const skeleton = canonicalizeTemplateGraph(buildTemplateGraphFromEvents(events));
        await this.memory.insertProceduralTemplate({
          scopeId,
          content: writeGuard(intentSummary),
          intentDescription: writeGuard(intentSummary),
          templateGraph: skeleton,
          embeddingLiteral: wlLiteral(skeleton),
          intentEmbeddingLiteral,
          isAntiPattern: false,
        });
        await this.writes.write({
          scopeId,
          entityId,
          predecessorHash,
          payload: {
            memory_type: 'procedural',
            content_hash: contentFingerprint(intentSummary),
            is_anti_pattern: false,
          },
          eventType: 'memory_updated',
        });
      } catch {
        /* positive skeleton failure must not break the scope_closed pass */
      }
    }

    // Step 6 (Phase 10): reinforcement closure — templates injected into this scope
    // are adopted (the scope converged and closed). P1-D SQL call path.
    try {
      const injectedIds = await this.memory.getInjectedTemplateIds(scopeId);
      for (const templateId of injectedIds) {
        await this.memory.reinforceTemplate(templateId);
      }
    } catch {
      /* reinforcement failure must not break the scope_closed pass */
    }

    // Step 7: success-correlation negative samples (D-05 upgraded, Phase 10).
    // failure→fix causal pair: orphan event + the corrective path that followed it.
    const orphanEvents = this.detectOrphanEvents(events);
    for (const orphan of orphanEvents) {
      try {
        const orphanIndex = events.indexOf(orphan);
        const correctivePath = events.slice(orphanIndex + 1);
        const failureGraph = canonicalizeTemplateGraph({
          ...buildTemplateGraphFromEvents([orphan, ...correctivePath]),
          correlation_confidence: correctivePath.length > 0 ? 'high' : 'low',
        });
        await this.memory.insertProceduralTemplate({
          scopeId,
          content: writeGuard('orphan-entity:' + orphan.entity_id),
          intentDescription: writeGuard(
            'Orphan node — entity ' +
              orphan.entity_id +
              ' had no successor events in scope ' +
              scopeId,
          ),
          templateGraph: failureGraph,
          embeddingLiteral: wlLiteral(failureGraph),
          intentEmbeddingLiteral: null,
          isAntiPattern: true,
        });
        await this.writes.write({
          scopeId,
          entityId: orphan.entity_id,
          predecessorHash,
          payload: {
            memory_type: 'procedural',
            content_hash: contentFingerprint('orphan:' + orphan.entity_id),
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
