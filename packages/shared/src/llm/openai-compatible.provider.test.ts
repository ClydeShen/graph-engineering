/**
 * openai-compatible.provider.test.ts — endpoint URL construction.
 *
 * Root cause (systematic-debugging session): the provider hardcoded
 * `${baseUrl}/v1/...`, but cloud profiles' baseUrl already ends in a version
 * segment (api.openai.com/v1, integrate.api.nvidia.com/v1, Gemini's
 * /v1beta/openai). That doubled the path → 404 on every strict gateway, for
 * BOTH chat and embeddings. Only local (bare-host) and lenient (DeepSeek)
 * survived, and all live testing was local — masking it.
 *
 * These tests pin the exact URL for versioned and bare-host bases so the
 * doubling can never come back.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';

afterEach(() => vi.unstubAllGlobals());

function stubOk(json: unknown) {
  const spy = vi.fn((_url: string, _init?: unknown) =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(json) }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

const CHAT_JSON = { choices: [{ message: { content: 'hi' } }] };
const EMBED_JSON = { data: [{ embedding: [0.1, 0.2] }] };

describe('OpenAICompatibleProvider endpoint URL', () => {
  it('versioned cloud base (…/v1) appends the route WITHOUT a second /v1 — chat', async () => {
    const spy = stubOk(CHAT_JSON);
    await new OpenAICompatibleProvider({
      api: 'openai-completions',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
    }).chat([{ role: 'user', content: 'hi' }]);
    expect(spy.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('versioned cloud base (…/v1) — embeddings', async () => {
    const spy = stubOk(EMBED_JSON);
    await new OpenAICompatibleProvider({
      api: 'openai-completions',
      model: 'baai/bge-m3',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    }).embed('text');
    expect(spy.mock.calls[0]![0]).toBe('https://integrate.api.nvidia.com/v1/embeddings');
  });

  it('Gemini-style versioned base (/v1beta/openai) is treated as versioned', async () => {
    const spy = stubOk(CHAT_JSON);
    await new OpenAICompatibleProvider({
      api: 'openai-completions',
      model: 'gemini-2.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }).chat([{ role: 'user', content: 'hi' }]);
    expect(spy.mock.calls[0]![0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    );
  });

  it('bare-host local base (no version) gets /v1 added — chat', async () => {
    const spy = stubOk(CHAT_JSON);
    await new OpenAICompatibleProvider({
      api: 'openai-completions',
      model: 'llama3',
      baseUrl: 'http://localhost:11434',
    }).chat([{ role: 'user', content: 'hi' }]);
    expect(spy.mock.calls[0]![0]).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('bare-host local base — embeddings', async () => {
    const spy = stubOk(EMBED_JSON);
    await new OpenAICompatibleProvider({
      api: 'openai-completions',
      model: 'nomic-embed-text',
      baseUrl: 'http://localhost:8080',
    }).embed('text');
    expect(spy.mock.calls[0]![0]).toBe('http://localhost:8080/v1/embeddings');
  });

  it('trailing slash on the base is not doubled', async () => {
    const spy = stubOk(CHAT_JSON);
    await new OpenAICompatibleProvider({
      api: 'openai-completions',
      model: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1/',
    }).chat([{ role: 'user', content: 'hi' }]);
    expect(spy.mock.calls[0]![0]).toBe('https://api.openai.com/v1/chat/completions');
  });
});
