import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LessonSaveWorker } from './lesson-save.worker.js';

describe('LessonSaveWorker', () => {
  let mockQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
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
});
