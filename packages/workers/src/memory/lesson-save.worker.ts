import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { notify, contentFingerprint } from '@graph/shared';
import type { MemoryRepository } from '../base/memory-repository.js';

export const LESSON_SAVE_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::lesson-save',
  config: { topic: 'graph::memory::lesson-save' },
} as const;

export class LessonSaveWorker {
  private readonly skillsDir: string;

  constructor(
    private readonly memory: MemoryRepository,
    skillsDir?: string,
  ) {
    this.skillsDir = skillsDir ?? process.env['SKILLS_DIR'] ?? './skills';
  }

  async onLessonSave(
    payload: { content: string; confidence?: number },
  ): Promise<{ fingerprint_id: string; action: 'reinforced' | 'created' }> {
    const fingerprintId = contentFingerprint(payload.content);
    const threshold = parseFloat(process.env['SKILL_EXPORT_THRESHOLD'] ?? '0.7');

    const existing = await this.memory.lookupLesson(fingerprintId);

    if (existing !== null) {
      // Ebbinghaus reinforcement: confidence += 0.1 * (1 - confidence), capped at 1.0
      await this.memory.reinforceLessonConfidence(fingerprintId);

      const prevConf = existing.confidence;
      const newConf = Math.min(1.0, prevConf + 0.1 * (1 - prevConf));
      if (prevConf < threshold && newConf >= threshold) {
        await this.exportSkill(fingerprintId, payload.content);
      }

      return { fingerprint_id: fingerprintId, action: 'reinforced' };
    }

    // New lesson: always inserted with confidence=0.5 regardless of payload.confidence.
    // Lessons earn export through Ebbinghaus reinforcement, not on first appearance.
    await this.memory.insertLesson(fingerprintId, payload.content);
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
