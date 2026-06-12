/**
 * dispatchMessage router tests (ADR 54): channel messages route through the
 * gateway conversation core (/chat REST) and return the assistant reply —
 * conversation no longer spawns message-handler tasks.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const mockResolveSessionScope = vi.fn().mockResolvedValue({
  scopeId: 'session-scope-id',
  predecessorHash: 's'.repeat(64),
  resumed: true,
});
vi.mock('./session-scope.js', () => ({
  resolveSessionScope: (...a: unknown[]) => mockResolveSessionScope(...a),
}));

function makeFetch(status: number, body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

describe('dispatchMessage router (ADR 54)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('TD-E: resolves the session scope, posts to /chat, returns the reply', async () => {
    const pool = {} as Pool;
    const fetchFn = makeFetch(200, { reply: 'hello human' });
    const { dispatchMessage } = await import('./router.js');

    const reply = await dispatchMessage('telegram::123456', 'hello', pool, 'update-id-999', fetchFn);

    expect(reply).toBe('hello human');
    expect(mockResolveSessionScope).toHaveBeenCalledWith(pool, 'telegram::123456');

    const [url, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/scopes/session-scope-id/chat');
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body['text']).toBe('hello');
    expect(body['source_message_id']).toBe('update-id-999');
    // Conversation turns carry NO required_skills (ADR 54 D-4)
    expect(body['required_skills']).toBeUndefined();
    // Channel identity flows as principal attribution
    expect((init.headers as Record<string, string>)['X-Agent-ID']).toBe('telegram::123456');
  });

  it('gateway error surfaces as a user-visible warning string', async () => {
    const pool = {} as Pool;
    const fetchFn = makeFetch(422, { error: 'no chat provider configured' });
    const { dispatchMessage } = await import('./router.js');

    const reply = await dispatchMessage('discord::ch1', 'test', pool, 'int-1', fetchFn);
    expect(reply).toContain('no chat provider configured');
  });

  it('non-JSON gateway failure degrades to a status message', async () => {
    const pool = {} as Pool;
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error('not json')),
    }) as unknown as typeof fetch;
    const { dispatchMessage } = await import('./router.js');

    const reply = await dispatchMessage('telegram::1', 'x', pool, 'm1', fetchFn);
    expect(reply).toContain('500');
  });
});
