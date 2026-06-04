import type { Pool } from 'pg';
import { writeGuard } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';

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
  private readonly pool: Pool;
  private readonly llm: LLMProvider;

  constructor(pool: Pool, llm: LLMProvider) {
    this.pool = pool;
    this.llm = llm;
  }

  async runSynthesis(scopeId: string): Promise<SynthesisResult> {
    const { rows } = await this.pool.query<{ scope_id: string; content: string }>(
      `SELECT scope_id, content FROM episodic_memory
       WHERE created_at > NOW() - INTERVAL '25 hours'
         AND scope_id = $1
       ORDER BY created_at ASC
       LIMIT 100`,
      [scopeId],
    );
    if (rows.length === 0) return { skipped: true };

    const combined = rows.map((r) => r.content).join('\n');
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
    const nodes = rows.map((_, i) => ({ id: `node-${i}`, event_type: 'episodic_trace' }));
    const edges = rows
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
    // Ebbinghaus decay — pure SQL, NO LLM call (ADR 20 Task 3)
    await this.pool.query(`
      UPDATE procedural_memory
      SET superseded_by = id
      WHERE reinforcement_count = 0
        AND last_used_at < NOW() - INTERVAL '90 days'
        AND superseded_by IS NULL
    `);
  }

  async runTtlPurge(): Promise<void> {
    // working_memory 24h TTL — pure SQL, NO LLM call
    await this.pool.query(
      `DELETE FROM working_memory WHERE created_at < NOW() - INTERVAL '24 hours'`,
    );
  }
}
