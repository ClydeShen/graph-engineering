import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { StubMemoryRepository } from '../base/memory-repository.js';
import { LessonSaveWorker } from './lesson-save.worker.js';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe('LessonSaveWorker', () => {
  let memory: StubMemoryRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    memory = new StubMemoryRepository();
    delete process.env['SKILL_EXPORT_THRESHOLD'];
  });

  it('creates new lesson when fingerprint not found (confidence=0.5)', async () => {
    // memory.lookupLesson returns null by default
    const worker = new LessonSaveWorker(memory);
    const result = await worker.onLessonSave({ content: 'new lesson content' });

    expect(result.action).toBe('created');
    expect(result.fingerprint_id).toHaveLength(64); // SHA-256 hex
    expect(memory.calls.insertLesson).toHaveLength(1);
    expect(memory.calls.insertLesson[0].fingerprintId).toBe(result.fingerprint_id);
  });

  it('reinforces existing lesson via memory.reinforceLessonConfidence', async () => {
    memory.setLookupLesson({ fingerprintId: 'fp-abc', confidence: 0.7, content: 'existing' });
    const worker = new LessonSaveWorker(memory);
    const result = await worker.onLessonSave({ content: 'existing lesson' });

    expect(result.action).toBe('reinforced');
    expect(memory.calls.reinforceLessonConfidence).toHaveLength(1);
    expect(memory.calls.insertLesson).toHaveLength(0);
  });

  it('same content always produces the same fingerprint_id (dedup)', async () => {
    const worker = new LessonSaveWorker(memory);
    const r1 = await worker.onLessonSave({ content: 'dedup me' });
    const r2 = await worker.onLessonSave({ content: 'dedup me' });

    expect(r1.fingerprint_id).toBe(r2.fingerprint_id);
  });

  it('exportSkill called when reinforcement crosses default 0.7 threshold', async () => {
    // prevConf=0.67, newConf = 0.67 + 0.1*(1-0.67) = 0.703 ≥ 0.7
    memory.setLookupLesson({ fingerprintId: 'fp-cross', confidence: 0.67, content: 'existing' });
    const worker = new LessonSaveWorker(memory, '/tmp/test-skills');
    await worker.onLessonSave({ content: '# my-skill\nA useful skill description' });

    expect(vi.mocked(mkdir)).toHaveBeenCalledWith(
      expect.stringContaining('test-skills'),
      { recursive: true },
    );
    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining('SKILL.md'),
      expect.stringContaining('name: my-skill'),
      'utf8',
    );
  });

  it('exportSkill not called when reinforcement stays below threshold', async () => {
    // prevConf=0.5, newConf = 0.5 + 0.1*(1-0.5) = 0.55 < 0.7
    memory.setLookupLesson({ fingerprintId: 'fp-stay', confidence: 0.5, content: 'existing' });
    const worker = new LessonSaveWorker(memory, '/tmp/test-skills');
    await worker.onLessonSave({ content: 'lesson below threshold' });

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('exportSkill not called on created action (confidence hardcoded to 0.5 < threshold 0.7)', async () => {
    const worker = new LessonSaveWorker(memory, '/tmp/test-skills');
    await worker.onLessonSave({ content: 'brand new lesson' });

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('exportSkill called when reinforcement crosses custom SKILL_EXPORT_THRESHOLD', async () => {
    process.env['SKILL_EXPORT_THRESHOLD'] = '0.3';
    // prevConf=0.26, newConf = 0.26 + 0.1*(1-0.26) = 0.334 ≥ 0.3
    memory.setLookupLesson({ fingerprintId: 'fp-custom', confidence: 0.26, content: 'existing' });
    const worker = new LessonSaveWorker(memory, '/tmp/test-skills');
    await worker.onLessonSave({ content: '# custom-threshold-skill\nCustom threshold test' });

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining('SKILL.md'),
      expect.stringContaining('custom-threshold-skill'),
      'utf8',
    );
  });
});
