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
    private readonly embed: EmbeddingProvider | null,
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

  /**
   * Fold a new run's corrected runbook INTO the prior canonical one (B1
   * consolidation, docs/benchmarks/emergence-loop-validation.md §5.5). One LLM
   * call — union/dedup of prose ordering rules is not deterministic (ADR-22).
   * The result is the SUPERSET: every distinct "X before Y" rule from either
   * runbook, deduplicated, contradictions resolved toward the more complete
   * ordering. This is what lets recall inject ONE runbook carrying ALL the
   * hidden rules, instead of a different partial each run. Merge failure must
   * not break scope close — fall back to this run's lesson.
   */
  private async mergeRunbooks(prior: string, fresh: string): Promise<string> {
    try {
      const merged = await this.llm.chat([
        {
          role: 'system',
          content:
            'You merge two runbooks for the SAME task into one canonical runbook. ' +
            'Output prose only (no JSON). Keep EVERY distinct ordering rule from both ' +
            'inputs, phrase each as "X must be done before Y", list each step ONCE, ' +
            'remove duplicates, and if the two disagree prefer the more complete and ' +
            'internally consistent ordering. Do not invent steps that appear in neither input.',
        },
        { role: 'user', content: writeGuard(`PRIOR canonical runbook:\n${prior}\n\nNEW run lesson:\n${fresh}`) },
      ]);
      const trimmed = merged.trim();
      return trimmed.length > 0 ? trimmed : fresh;
    } catch {
      return fresh;
    }
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
          'You are analyzing an agent execution trace to extract a REUSABLE procedure. ' +
          'Return ONLY valid JSON: {"intent_summary":"...","outcome_summary":"...","lesson":"..."}. ' +
          'intent_summary and outcome_summary are one sentence each. ' +
          'lesson is the actionable structure a future agent needs to do this RIGHT THE FIRST TIME. ' +
          'State the CORRECTED, optimal order of the concrete named steps — the order that AVOIDS the ' +
          'mistakes in this trace. If a step failed and had to be retried after another step ran, do ' +
          'NOT replay that mistake: instead put the prerequisite first and list each step ONCE. Phrase ' +
          'every non-obvious dependency as a rule "X must be done before Y". Omit if there is no reusable order.',
      },
      { role: 'user', content: writeGuard(scopeText) },
    ]);

    let intentSummary: string;
    let outcomeSummary: string;
    let lesson = '';
    try {
      const parsed = JSON.parse(llmResponse) as { intent_summary: string; outcome_summary: string; lesson?: string };
      intentSummary = parsed.intent_summary;
      outcomeSummary = parsed.outcome_summary;
      if (typeof parsed.lesson === 'string') lesson = parsed.lesson.trim();
    } catch {
      intentSummary = llmResponse.substring(0, 300);
      outcomeSummary = 'outcome extraction failed';
    }

    // L2 fidelity (docs/benchmarks/emergence-loop-validation.md): the injected
    // template must carry the ACTIONABLE lesson (step order / dependency
    // constraints), not just a generic "what happened" summary. The anonymized
    // template_graph serves topological recall; this readable lesson is what a
    // future agent actually reads in mem::reflect's procedural section.
    const actionableContent = lesson ? `${intentSummary}\nLesson: ${lesson}` : intentSummary;

    // Step 3: LLM CALL — ADR 22 (embedding calls not counted against Worker token budget)
    // The intent+outcome embedding is reused as the positive template's intent_embedding
    // (one embed call serves both writes — token efficiency, ADR-25 suppl 2).
    // ADR 55: embedding absent/unreachable → NULL embedding + backlog enqueue.
    // (Replaces the old zero-vector fallback, which poisoned cosine similarity;
    // the partial HNSW index simply skips NULL rows until backfill.)
    const embedText = writeGuard(intentSummary) + '\n' + writeGuard(outcomeSummary);
    let intentEmbeddingLiteral: string | null = null;
    if (this.embed !== null) {
      try {
        const { vector } = await this.embed.embed(embedText);
        intentEmbeddingLiteral = '[' + vector.join(',') + ']';
      } catch {
        /* late projection below */
      }
    }
    const { id: episodicId } = await this.memory.appendEpisodicSummary(
      scopeId,
      entityId,
      writeGuard(intentSummary),
      writeGuard(outcomeSummary),
      intentEmbeddingLiteral,
    );
    if (intentEmbeddingLiteral === null) {
      await this.memory.enqueueEmbeddingBackfill('episodic_memory', episodicId, 'embedding', embedText);
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
        // B1 consolidation (a): match the prior canonical by DETERMINISTIC topology,
        // not LLM-prose intent embedding. The intent summary drifts run-to-run, so the
        // first attempt matched only ~1/3 of repeats and the partial-runbook mixture
        // re-formed. The canonical graph is computed from the event DAG and is
        // identical for the same converged trajectory → reliable consolidation. A run
        // that STUMBLED has extra rework events → a different graph → it cannot match
        // (and so cannot poison) the clean canonical. When a prior is found, fold this
        // run's lesson into it as ONE superset runbook and supersede it.
        const skeleton = canonicalizeTemplateGraph(buildTemplateGraphFromEvents(events));
        const topologyLiteral = wlLiteral(skeleton);
        let supersedePriorId: string | null = null;
        let canonicalContent = actionableContent;
        const prior = await this.memory.findMergeableTemplate(topologyLiteral, scopeId);
        if (prior) {
          canonicalContent = await this.mergeRunbooks(prior.content, actionableContent);
          supersedePriorId = prior.id;
        }
        const { id: templateId } = await this.memory.insertProceduralTemplate({
          scopeId,
          content: writeGuard(canonicalContent),
          intentDescription: writeGuard(canonicalContent),
          templateGraph: skeleton,
          embeddingLiteral: topologyLiteral,
          intentEmbeddingLiteral,
          isAntiPattern: false,
        });
        // Supersede AFTER the new canonical row exists, so recall never sees a gap
        // (append-only: the old row is kept, just marked superseded_by the new id).
        if (supersedePriorId !== null) {
          await this.memory.supersedeTemplate(supersedePriorId, templateId);
        }
        if (intentEmbeddingLiteral === null) {
          await this.memory.enqueueEmbeddingBackfill('procedural_memory', templateId, 'intent_embedding', embedText);
        }
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
