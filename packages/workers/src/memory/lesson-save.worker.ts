import { createHash } from 'crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { notify } from '@graph/shared';

export const LESSON_SAVE_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::lesson-save',
  config: { topic: 'graph::memory::lesson-save' },
} as const;

export class LessonSaveWorker {
  private readonly skillsDir: string;

  constructor(
    private readonly pool: Pool,
    skillsDir?: string,
  ) {
    this.skillsDir = skillsDir ?? process.env['SKILLS_DIR'] ?? './skills';
  }

  async onLessonSave(
    payload: { content: string; confidence?: number },
  ): Promise<{ fingerprint_id: string; action: 'reinforced' | 'created' }> {
    const fingerprintId = createHash('sha256').update(payload.content).digest('hex');
    const threshold = parseFloat(process.env['SKILL_EXPORT_THRESHOLD'] ?? '0.7');

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

      const prevConf = rows[0].confidence;
      const newConf = Math.min(1.0, prevConf + 0.1 * (1 - prevConf));
      if (prevConf < threshold && newConf >= threshold) {
        await this.exportSkill(fingerprintId, payload.content);
      }

      return { fingerprint_id: fingerprintId, action: 'reinforced' };
    }

    // New lesson: always inserted with confidence=0.5 regardless of payload.confidence.
    // Lessons earn export through Ebbinghaus reinforcement, not on first appearance.
    await this.pool.query(
      `INSERT INTO procedural_memory
         (fingerprint_id, content, confidence, quality_score, reinforcement_count, last_used_at, superseded_by)
       VALUES ($1, $2, 0.5, 0.5, 0, NOW(), NULL)`,
      [fingerprintId, payload.content],
    );
    return { fingerprint_id: fingerprintId, action: 'created' };
  }

  async exportSkill(fingerprintId: string, content: string): Promise<void> {
    const lines = content.split('\n');
    const rawName = (lines[0] ?? '').replace(/^#+\s*/, '').trim().slice(0, 64);
    const name = rawName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const description = lines
      .slice(1)
      .map(l => l.trim())
      .find(l => l.length > 0)
      ?.slice(0, 200) ?? '';

    const dir = join(this.skillsDir, fingerprintId);
    await mkdir(dir, { recursive: true });

    const frontmatter = [
      '---',
      `name: ${name || fingerprintId.slice(0, 8)}`,
      `description: ${description}`,
      'source: graph-runtime',
      `fingerprint_id: ${fingerprintId}`,
      'requires:',
      '  bins: []',
      '  env: []',
      'always: false',
      '---',
      '',
      content,
    ].join('\n');

    await writeFile(join(dir, 'SKILL.md'), frontmatter, 'utf8');

    await notify({ type: 'lesson', fingerprint_id: fingerprintId, summary: content.slice(0, 200) });
  }
}
