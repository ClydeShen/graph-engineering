import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { LessonSaveWorker } from './lesson-save.worker.js';

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

describe('LessonSaveWorker', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['SKILL_EXPORT_THRESHOLD'];
  });

  it('creates new lesson when fingerprint not found (confidence=0.5)', async () => {
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })   // SELECT → not found
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });   // INSERT

    const worker = new LessonSaveWorker({ query: mockQuery } as never);
    const result = await worker.onLessonSave({ content: 'new lesson content' });

    expect(result.action).toBe('created');
    expect(result.fingerprint_id).toHaveLength(64); // SHA-256 hex
    const insertCall = mockQuery.mock.calls[1][0] as string;
    expect(insertCall).toContain('INSERT INTO procedural_memory');
    // default confidence 0.5 is in the SQL VALUES
    expect(mockQuery.mock.calls[1][1]).toContain(result.fingerprint_id);
  });

  it('reinforces existing lesson (confidence formula applied)', async () => {
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ fingerprint_id: 'fp-abc', confidence: 0.7 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });   // UPDATE

    const worker = new LessonSaveWorker({ query: mockQuery } as never);
    const result = await worker.onLessonSave({ content: 'existing lesson' });

    expect(result.action).toBe('reinforced');
    const updateCall = mockQuery.mock.calls[1][0] as string;
    expect(updateCall).toContain('LEAST(1.0, confidence + 0.1 * (1 - confidence))');
  });

  it('same content always produces the same fingerprint_id (dedup)', async () => {
    mockQuery = vi.fn()
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const worker = new LessonSaveWorker({ query: mockQuery } as never);
    const r1 = await worker.onLessonSave({ content: 'dedup me' });
    const r2 = await worker.onLessonSave({ content: 'dedup me' });

    expect(r1.fingerprint_id).toBe(r2.fingerprint_id);
  });

  it('exportSkill called when reinforcement crosses default 0.7 threshold', async () => {
    // prevConf=0.67, newConf = 0.67 + 0.1*(1-0.67) = 0.703 ≥ 0.7
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ fingerprint_id: 'fp-cross', confidence: 0.67 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const worker = new LessonSaveWorker({ query: mockQuery } as never, '/tmp/test-skills');
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
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ fingerprint_id: 'fp-stay', confidence: 0.5 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const worker = new LessonSaveWorker({ query: mockQuery } as never, '/tmp/test-skills');
    await worker.onLessonSave({ content: 'lesson below threshold' });

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('exportSkill not called on created action (confidence hardcoded to 0.5 < threshold 0.7)', async () => {
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const worker = new LessonSaveWorker({ query: mockQuery } as never, '/tmp/test-skills');
    await worker.onLessonSave({ content: 'brand new lesson' });

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('exportSkill called when reinforcement crosses custom SKILL_EXPORT_THRESHOLD', async () => {
    process.env['SKILL_EXPORT_THRESHOLD'] = '0.3';
    // prevConf=0.26, newConf = 0.26 + 0.1*(1-0.26) = 0.334 ≥ 0.3
    mockQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ fingerprint_id: 'fp-custom', confidence: 0.26 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const worker = new LessonSaveWorker({ query: mockQuery } as never, '/tmp/test-skills');
    await worker.onLessonSave({ content: '# custom-threshold-skill\nCustom threshold test' });

    expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
      expect.stringContaining('SKILL.md'),
      expect.stringContaining('custom-threshold-skill'),
      'utf8',
    );
  });
});
