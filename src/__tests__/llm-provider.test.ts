/**
 * Unit tests for OpenAICompatibleProvider.
 *
 * Mocks `fetch` globally — no real network calls.
 * Asserts: correct POST targets, no hardcoded credential literals in source.
 *
 * @see ADR 22 — LLM Provider Abstraction
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { OpenAICompatibleProvider } from '../../packages/shared/src/llm/openai-compatible.provider.js';

const BASE_URL = 'http://localhost:11434';
const MODEL = 'llama3';
const API_KEY = 'test-key-injected';

function makeProvider() {
  return new OpenAICompatibleProvider({ baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY });
}

describe('OpenAICompatibleProvider', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('chat() POSTs to /v1/chat/completions', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'hello' } }] }),
    } as Response);

    const provider = makeProvider();
    const result = await provider.chat([{ role: 'user', content: 'hi' }]);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${BASE_URL}/v1/chat/completions`);
    expect(result).toBe('hello');
  });

  it('embed() POSTs to /v1/embeddings', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    } as Response);

    const provider = makeProvider();
    const result = await provider.embed('some text');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0] as [string, ...unknown[]];
    expect(url).toBe(`${BASE_URL}/v1/embeddings`);
    expect(result.vector).toEqual([0.1, 0.2, 0.3]);
    expect(result.countedAgainstBudget).toBe(false);
  });

  it('embed() result is always countedAgainstBudget: false (ADR 22)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [1] }] }),
    } as Response);

    const result = await makeProvider().embed('x');
    expect(result.countedAgainstBudget).toBe(false);
  });

  it('provider source contains no hardcoded credential literals (sk- pattern)', () => {
    const srcPath = join(
      process.cwd(),
      'packages/shared/src/llm/openai-compatible.provider.ts',
    );
    const src = readFileSync(srcPath, 'utf-8');
    expect(src).not.toMatch(/sk-[A-Za-z0-9]+/);
    expect(src).not.toMatch(/api[_-]?key\s*=\s*['"][^'"]+['"]/i);
  });

  it('chat() throws on non-OK response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    } as Response);

    await expect(makeProvider().chat([{ role: 'user', content: 'x' }])).rejects.toThrow('503');
  });
});
