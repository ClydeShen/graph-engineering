import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicProvider } from './anthropic.provider.js';

const config = {
  api: 'anthropic-messages' as const,
  model: 'claude-haiku-4-5-20251001',
  apiKey: 'test-key',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('AnthropicProvider', () => {
  it('returns text block from successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Hello world' }],
      }),
    } as Response);

    const provider = new AnthropicProvider(config);
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('Hello world');
  });

  it('throws on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response);

    const provider = new AnthropicProvider(config);
    await expect(provider.chat([{ role: 'user', content: 'hi' }]))
      .rejects.toThrow('Anthropic chat request failed: 401 Unauthorized');
  });

  it('returns empty string when no text block in content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'x', name: 'fn', input: {} }],
      }),
    } as Response);

    const provider = new AnthropicProvider(config);
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(result).toBe('');
  });

  it('uses custom baseUrl when provided', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    } as Response);

    const provider = new AnthropicProvider({ ...config, baseUrl: 'https://custom.example.com' });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(spy).toHaveBeenCalledWith(
      'https://custom.example.com/v1/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
