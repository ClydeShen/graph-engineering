import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { AskUserService } from './ask-user.js';

function makePool(results: Array<{ rows: unknown[] }>): {
  pool: Pool;
  calls: Array<{ sql: string; params: unknown[] | undefined }>;
} {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  let i = 0;
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      return results[Math.min(i++, results.length - 1)] ?? { rows: [] };
    }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('AskUserService', () => {
  it('ask files the question row, audits, and pushes with expects_reply', async () => {
    const { pool, calls } = makePool([{ rows: [] }]);
    const deliver = vi.fn(async () => ({}));
    const svc = new AskUserService(pool, { deliver });
    const id = await svc.ask('scope-1', 'agent-a', 'Which slot, 6pm or 7pm?');

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]!.sql).toContain('INSERT INTO user_question');
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ expects_reply: true, scope_id: 'scope-1' }),
    );
    const pushed = (deliver.mock.calls[0] as unknown[])[0] as { text: string };
    expect(pushed.text).toContain('Which slot');
  });

  it('answer transitions pending→answered and audits; non-pending returns false', async () => {
    const answered = makePool([{ rows: [{ scope_id: 'scope-1' }] }, { rows: [] }]);
    expect(await new AskUserService(answered.pool).answer('q-1', '7pm')).toBe(true);
    expect(answered.calls[0]!.sql).toContain("status = 'answered'");

    const notPending = makePool([{ rows: [] }]);
    expect(await new AskUserService(notPending.pool).answer('q-1', '7pm')).toBe(false);
  });

  it('sweepTimeouts denies-by-silence and audits each timeout', async () => {
    const { pool, calls } = makePool([
      { rows: [{ id: 'q-1', scope_id: 's-1' }, { id: 'q-2', scope_id: 's-2' }] },
      { rows: [] },
    ]);
    const swept = await new AskUserService(pool).sweepTimeouts(60_000);
    expect(swept).toBe(2);
    expect(calls[0]!.sql).toContain("status = 'timed_out'");
  });

  it('push failure never loses the pending row', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const svc = new AskUserService(pool, {
      deliver: vi.fn(async () => {
        throw new Error('channel down');
      }),
    });
    await expect(svc.ask('scope-1', 'a', 'q?')).resolves.toMatch(/^[0-9a-f-]{36}$/);
  });
});
