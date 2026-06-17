import { writeGuard, logger, LOG_EVENTS } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';
import type { TrailReader } from '../base/trail-reader.js';
import type { MemoryRepository } from '../base/memory-repository.js';
import { FRESHNESS } from './freshness-config.js';

export const SYNTHESIZER_CRON_TRIGGER = {
  type: 'cron' as const,
  function_id: 'graph::memory::synthesizer',
  config: { expression: '0 0 2 * * * *' },
} as const;

export const DECAY_CRON_TRIGGER = {
  type: 'cron' as const,
  function_id: 'graph::memory::decay',
  config: { expression: '0 0 3 * * * *' },
} as const;

export const TTL_CRON_TRIGGER = {
  type: 'cron' as const,
  function_id: 'graph::memory::ttl',
  config: { expression: '0 0 4 * * * *' },
} as const;

type SynthesisResult =
  | { skipped: true }
  | {
      skipped: false;
      scope_id: string;
      intent_description: string;
      template_graph: { steps: string[] };
      nodes: { id: string; event_type: string }[];
      edges: { source: string; target: string }[];
    };

export class MemorySynthesizerWorker {
  readonly base_priority = 1;

  constructor(
    private readonly reader: TrailReader,
    private readonly memory: MemoryRepository,
    private readonly llm: LLMProvider,
  ) {}

  async runSynthesis(scopeId: string): Promise<SynthesisResult> {
    const records = await this.reader.getEpisodicRecords(scopeId, { sinceHours: 25, limit: 100 });
    if (records.length === 0) return { skipped: true };

    const combined = records.join('\n');
    // LLM CALL — ADR 22 (batch distillation; cannot be deterministic)
    const summary = await this.llm.chat([
      {
        role: 'system',
        content:
          'Distill execution traces into reusable workflow templates. Output JSON with fields: intent_description (string), steps (string[]).',
      },
      { role: 'user', content: writeGuard(combined) },
    ]);

    let parsed: { intent_description?: string; steps?: string[] } = {};
    try {
      parsed = JSON.parse(summary) as typeof parsed;
    } catch {
      /* non-JSON — use raw output */
    }

    const intentDescription = parsed.intent_description ?? summary;
    const nodes = records.map((_, i) => ({ id: `node-${i}`, event_type: 'episodic_trace' }));
    const edges = records
      .slice(1)
      .map((_, i) => ({ source: `node-${i}`, target: `node-${i + 1}` }));

    return {
      skipped: false,
      scope_id: scopeId,
      intent_description: intentDescription,
      template_graph: { steps: parsed.steps ?? [] },
      nodes,
      edges,
    };
  }

  async runDecay(): Promise<void> {
    // The cron metabolism sweep — pure SQL, NO LLM call. Two distinct causes
    // coexist (GH #32): atrophy (90d-unused time-decay, ADR 20 Task 3) and
    // apoptosis (failure-evidence-driven). Both are reversible logical deletes.
    await this.memory.markSupersededByEbbinghaus();

    // Apoptosis: retire crystallizations with STRONG evidence of being bad. The
    // ambiguous middle is deliberately NOT touched here — it is surfaced to human
    // triage (getMetabolismTriage) instead of silently decided. Metabolism must
    // be observable, so each retirement is logged with the condemning evidence.
    const retired = await this.memory.metabolizeByEvidence({
      nMin: FRESHNESS.metabolismNMin,
      qualityBad: FRESHNESS.metabolismQualityBad,
    });
    for (const r of retired) {
      logger.child({ component: 'memory-metabolism', template_id: r.id }).info(
        { success_count: r.success_count, failure_count: r.failure_count, quality_score: r.quality_score },
        LOG_EVENTS.MEMORY_METABOLIZED,
      );
    }
  }

  async runTtlPurge(): Promise<void> {
    // working_memory 24h TTL — pure SQL, NO LLM call
    await this.memory.purgeTTLWorkingMemory();
  }
}
