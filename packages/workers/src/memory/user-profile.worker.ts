import type { Pool } from 'pg';
import { occWrite } from '@graph/shared';
import type { LLMProvider } from '@graph/shared';

export const USER_PROFILE_TRIGGER_CONFIG = {
  type: 'scheduled' as const,
  function_id: 'graph::memory::user-profile',
  config: { cron: '0 3 * * *' },
} as const;

export const USER_PROFILE_SCOPE_ID = '00000000-0000-4000-8000-000000000001';

const ZERO_HASH = '0'.repeat(64);
const MIN_CRYSTALS = 3;

export class UserProfileWorker {
  constructor(
    private readonly pool: Pool,
    private readonly llm: LLMProvider,
  ) {}

  async synthesize(userId: string): Promise<{ skipped: true } | { written: true }> {
    const { rows } = await this.pool.query<{ payload: string }>(
      `SELECT payload FROM execution_event_log
       WHERE entity_id = $1
         AND (payload::jsonb->>'source') = 'crystallize'
       ORDER BY created_at DESC
       LIMIT 50`,
      [userId],
    );

    if (rows.length < MIN_CRYSTALS) return { skipped: true };

    const combined = rows
      .map((r) => {
        const p = typeof r.payload === 'string' ? (JSON.parse(r.payload) as { crystal?: string }) : (r.payload as { crystal?: string });
        return p.crystal ?? '';
      })
      .filter(Boolean)
      .join('\n\n');

    // LLM CALL — ADR 22
    const llmOutput = await this.llm.chat([
      {
        role: 'system',
        content:
          'Synthesize a concise user profile from these execution Crystals. Focus on: working patterns, tool preferences, recurring challenges, effective strategies. 3-5 bullet points max.',
      },
      { role: 'user', content: combined },
    ]);

    await occWrite(this.pool, {
      scopeId: USER_PROFILE_SCOPE_ID,
      entityId: userId,
      predecessorHash: ZERO_HASH,
      eventType: 'memory_updated',
      payload: {
        profile: llmOutput,
        source: 'user-profile',
        user_id: userId,
        crystal_count: rows.length,
      },
    });

    return { written: true };
  }
}
