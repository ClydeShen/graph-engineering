import { createHash } from 'crypto';
import type { Pool } from 'pg';

export const LESSON_SAVE_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::lesson-save',
  config: { topic: 'graph::memory::lesson-save' },
} as const;

export class LessonSaveWorker {
  constructor(private readonly pool: Pool) {}

  async onLessonSave(
    payload: { content: string; confidence?: number },
  ): Promise<{ fingerprint_id: string; action: 'reinforced' | 'created' }> {
    const fingerprintId = createHash('sha256').update(payload.content).digest('hex');

    const { rows } = await this.pool.query<{ fingerprint_id: string; confidence: number }>(
      `SELECT fingerprint_id, confidence FROM procedural_memory WHERE fingerprint_id = $1 LIMIT 1`,
      [fingerprintId],
    );

    if (rows.length > 0) {
      // Ebbinghaus reinforcement: confidence += 0.1 * (1 - confidence), capped at 1.0
      await this.pool.query(
        `UPDATE procedural_memory
         SET confidence = LEAST(1.0, confidence + 0.1 * (1 - confidence)),
             reinforcement_count = reinforcement_count + 1
         WHERE fingerprint_id = $1`,
        [fingerprintId],
      );
      return { fingerprint_id: fingerprintId, action: 'reinforced' };
    }

    await this.pool.query(
      `INSERT INTO procedural_memory
         (fingerprint_id, content, confidence, quality_score, reinforcement_count, last_used_at, superseded_by)
       VALUES ($1, $2, 0.5, 0.5, 0, NOW(), NULL)`,
      [fingerprintId, payload.content],
    );
    return { fingerprint_id: fingerprintId, action: 'created' };
  }
}
