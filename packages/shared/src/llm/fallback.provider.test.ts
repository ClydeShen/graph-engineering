import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProvider, ChatMessage } from './provider.interface.js';
import { FallbackProvider, AllProvidersExhaustedError } from './fallback.provider.js';

const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }];

function makeProvider(impl: () => Promise<string>): LLMProvider {
  return { chat: vi.fn().mockImplementation(impl) };
}

describe('FallbackProvider', () => {
  it('returns the first successful provider response', async () => {
    const p1 = makeProvider(() => Promise.resolve('response from p1'));
    const p2 = makeProvider(() => Promise.resolve('response from p2'));
    const fallback = new FallbackProvider([
      { name: 'p1', provider: p1, priority: 1 },
      { name: 'p2', provider: p2, priority: 2 },
    ]);

    const result = await fallback.chat(messages);
    expect(result).toBe('response from p1');
    expect(p2.chat).not.toHaveBeenCalled();
  });

  it('re-throws immediately on shouldThrow error (auth) without trying next provider', async () => {
    const p1 = makeProvider(() => Promise.reject(new Error('401 Unauthorized')));
    const p2 = makeProvider(() => Promise.resolve('response from p2'));
    const fallback = new FallbackProvider([
      { name: 'p1', provider: p1, priority: 1 },
      { name: 'p2', provider: p2, priority: 2 },
    ]);

    await expect(fallback.chat(messages)).rejects.toThrow('401 Unauthorized');
    expect(p2.chat).not.toHaveBeenCalled();
  });

  it('tries next provider when first fails with shouldFailover error (rate_limit)', async () => {
    const p1 = makeProvider(() => Promise.reject(new Error('429 Too Many Requests')));
    const p2 = makeProvider(() => Promise.resolve('response from p2'));
    const fallback = new FallbackProvider([
      { name: 'p1', provider: p1, priority: 1 },
      { name: 'p2', provider: p2, priority: 2 },
    ]);

    const result = await fallback.chat(messages);
    expect(result).toBe('response from p2');
  });

  it('throws AllProvidersExhaustedError when all providers fail with shouldFailover', async () => {
    const p1 = makeProvider(() => Promise.reject(new Error('503 Service Unavailable')));
    const p2 = makeProvider(() => Promise.reject(new Error('network timeout')));
    const fallback = new FallbackProvider([
      { name: 'p1', provider: p1, priority: 1 },
      { name: 'p2', provider: p2, priority: 2 },
    ]);

    await expect(fallback.chat(messages)).rejects.toThrow(AllProvidersExhaustedError);
    await expect(fallback.chat(messages)).rejects.toThrow('All LLM providers exhausted');
  });

  it('tries providers in ascending priority order', async () => {
    const callOrder: string[] = [];
    const p1 = makeProvider(() => { callOrder.push('p1'); return Promise.reject(new Error('429')); });
    const p2 = makeProvider(() => { callOrder.push('p2'); return Promise.resolve('p2 ok'); });
    const fallback = new FallbackProvider([
      { name: 'p2', provider: p2, priority: 2 },
      { name: 'p1', provider: p1, priority: 1 },
    ]);

    await fallback.chat(messages);
    expect(callOrder).toEqual(['p1', 'p2']);
  });
});
