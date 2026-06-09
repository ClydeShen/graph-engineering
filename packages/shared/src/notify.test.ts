import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { notify } from './notify.js';

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['NOTIFY_WEBHOOK_URL'];
});

describe('notify', () => {
  it('is a no-op when NOTIFY_WEBHOOK_URL is not set', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    await notify({ type: 'crystal', scope_id: 'scope-1', summary: 'test' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('POSTs to NOTIFY_WEBHOOK_URL with content field', async () => {
    process.env['NOTIFY_WEBHOOK_URL'] = 'https://hooks.example.com/test';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok'));

    await notify({ type: 'crystal', scope_id: 'scope-1', summary: 'A crystal formed' });

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/test');
    const body = JSON.parse(init.body as string) as { content: string };
    expect(body.content).toContain('Crystal');
    expect(body.content).toContain('scope-1');
    expect(body.content).toContain('A crystal formed');
  });

  it('swallows errors without re-throwing', async () => {
    process.env['NOTIFY_WEBHOOK_URL'] = 'https://hooks.example.com/test';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));

    await expect(notify({ type: 'lesson', fingerprint_id: 'fp-1', summary: 'lesson content' }))
      .resolves.toBeUndefined();
  });
});
