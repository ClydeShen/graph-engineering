import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('Telegram long-poll adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
