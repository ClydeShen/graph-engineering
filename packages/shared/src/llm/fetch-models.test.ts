/**
 * fetch-models.test.ts — best-effort live model listing. The contract that
 * matters for onboarding: a correct list when the endpoint cooperates, and []
 * (never a throw) on every failure mode so the caller falls back to free text.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchModels } from './fetch-models.js';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const spy = vi.fn(impl);
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('fetchModels', () => {
  it('versioned OpenAI base → GET {base}/models with a Bearer header', async () => {
    const spy = stubFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
    }));

    const models = await fetchModels(
      { api: 'openai-completions' },
      'https://api.openai.com/v1',
      'sk-test',
    );

    expect(models).toEqual(['gpt-4o', 'gpt-4o-mini']);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/models');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer sk-test' });
  });

  it('bare-host base (ollama) → GET {base}/v1/models with no auth header', async () => {
    const spy = stubFetch(() => ({ ok: true, json: () => Promise.resolve({ data: [{ id: 'llama3' }] }) }));

    const models = await fetchModels({ api: 'openai-completions' }, 'http://localhost:11434', undefined);

    expect(models).toEqual(['llama3']);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('http://localhost:11434/v1/models');
    expect((init as RequestInit).headers).toEqual({});
  });

  it('anthropic → fixed REST endpoint with x-api-key + version header', async () => {
    const spy = stubFetch(() => ({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'claude-sonnet-4-6' }] }),
    }));

    const models = await fetchModels({ api: 'anthropic-messages' }, undefined, 'ant-key');

    expect(models).toEqual(['claude-sonnet-4-6']);
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect((init as RequestInit).headers).toMatchObject({
      'x-api-key': 'ant-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('anthropic without a key → [] (no request)', async () => {
    const spy = stubFetch(() => ({ ok: true, json: () => Promise.resolve({ data: [] }) }));
    expect(await fetchModels({ api: 'anthropic-messages' }, undefined, undefined)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('non-ok response → []', async () => {
    stubFetch(() => ({ ok: false, status: 403, json: () => Promise.resolve({}) }));
    expect(
      await fetchModels({ api: 'openai-completions' }, 'https://api.openai.com/v1', 'bad'),
    ).toEqual([]);
  });

  it('network throw → [] (never propagates)', async () => {
    stubFetch(() => {
      throw new Error('offline');
    });
    expect(
      await fetchModels({ api: 'openai-completions' }, 'http://localhost:11434', undefined),
    ).toEqual([]);
  });
});
