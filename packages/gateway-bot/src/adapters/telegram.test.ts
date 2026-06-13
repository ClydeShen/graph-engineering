import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Telegram long-poll adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // telegramFetch's proxy/IP-fallback machinery is exercised in
    // channel-http.test.ts; disable it here so the long-poll tests assert
    // poll/backoff behaviour against a single deterministic fetch per call.
    process.env['MEMEX_TELEGRAM_DISABLE_FALLBACK_IPS'] = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['MEMEX_TELEGRAM_DISABLE_FALLBACK_IPS'];
  });

  it('calls onMessage for each update and sends reply via sendMessage', async () => {
    const ac = new AbortController();

    const updates = [
      { update_id: 42, message: { chat: { id: 123 }, text: 'hello world' } },
    ];

    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('getUpdates')) {
        callCount++;
        if (callCount === 1) {
          return { ok: true, json: async () => ({ ok: true, result: updates }) };
        }
        // Abort after first batch so the loop exits
        ac.abort();
        return { ok: true, json: async () => ({ ok: true, result: [] }) };
      }
      // sendMessage
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const onMessage = vi.fn().mockResolvedValue('task-id-abc');

    const { startLongPoll } = await import('./telegram.js');
    await startLongPoll('fake-token', onMessage, ac.signal);

    expect(onMessage).toHaveBeenCalledWith('123', 'hello world', 42);
    // sendMessage call: URL includes sendMessage
    const sendCall = mockFetch.mock.calls.find(([url]) => String(url).includes('sendMessage'));
    expect(sendCall).toBeDefined();
    const body = JSON.parse(sendCall![1].body as string) as { chat_id: string; text: string };
    expect(body.chat_id).toBe('123');
    expect(body.text).toBe('task-id-abc');
  });

  it('backs off and de-dupes the log on repeated transport failures', async () => {
    const ac = new AbortController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('getUpdates')) {
        callCount++;
        if (callCount >= 3) ac.abort();
        throw new Error('fetch failed');
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const onMessage = vi.fn();
    const { startLongPoll } = await import('./telegram.js');
    await startLongPoll('fake-token', onMessage, ac.signal, { baseDelayMs: 1 });

    expect(onMessage).not.toHaveBeenCalled();
    expect(callCount).toBeGreaterThanOrEqual(3);
    // De-dup: identical "fetch failed" reason logs once, not once per retry.
    const pollFails = errSpy.mock.calls.filter(([m]) => String(m).includes('poll failing'));
    expect(pollFails.length).toBe(1);
    // The message is actionable, not undici's bare "fetch failed".
    expect(String(pollFails[0]![0])).toContain('cannot reach api.telegram.org');
  });

  it('backs off on ok:false (bad token) instead of tight-looping', async () => {
    const ac = new AbortController();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('getUpdates')) {
        callCount++;
        if (callCount >= 2) ac.abort();
        return { ok: true, json: async () => ({ ok: false, description: 'Unauthorized' }) };
      }
      return { ok: true, json: async () => ({ ok: true }) };
    });

    const onMessage = vi.fn();
    const { startLongPoll } = await import('./telegram.js');
    await startLongPoll('bad-token', onMessage, ac.signal, { baseDelayMs: 1 });

    expect(onMessage).not.toHaveBeenCalled();
    const pollFails = errSpy.mock.calls.filter(([m]) => String(m).includes('poll failing'));
    expect(pollFails.length).toBe(1);
    expect(String(pollFails[0]![0])).toContain('Unauthorized');
  });

  it('skips updates with no text or chat', async () => {
    const ac = new AbortController();
    let callCount = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('getUpdates')) {
        callCount++;
        if (callCount === 1) {
          return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 1 }] }) };
        }
        ac.abort();
        return { ok: true, json: async () => ({ ok: true, result: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const onMessage = vi.fn();
    const { startLongPoll } = await import('./telegram.js');
    await startLongPoll('fake-token', onMessage, ac.signal);

    expect(onMessage).not.toHaveBeenCalled();
  });
});
