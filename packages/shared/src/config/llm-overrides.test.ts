import { describe, it, expect } from 'vitest';
import { mergeLlmOverrides } from './llm-overrides.js';
import type { MemexConfig } from './loader.js';

const base: MemexConfig = {
  providers: [{ name: 'default', type: 'anthropic', model: 'claude', priority: 1 }],
  embedding: { provider: 'openai', model: 'text-embedding-3-small' },
};

describe('mergeLlmOverrides', () => {
  it('is the identity when there are no overrides (zero-regression)', () => {
    expect(mergeLlmOverrides(base, null)).toBe(base);
    expect(mergeLlmOverrides(base, {})).toBe(base);
  });

  it('replaces the provider registry with the single chat slot', () => {
    const merged = mergeLlmOverrides(base, {
      chat: { type: 'ollama', model: 'qwen3', baseUrl: 'http://localhost:11434' },
    });
    expect(merged?.providers).toHaveLength(1);
    expect(merged?.providers?.[0]).toMatchObject({ type: 'ollama', model: 'qwen3', priority: 1 });
    // embedding untouched when only chat is overridden
    expect(merged?.embedding?.model).toBe('text-embedding-3-small');
  });

  it('replaces the embedding section independently', () => {
    const merged = mergeLlmOverrides(base, {
      embedding: { type: 'openai', model: 'text-embedding-3-large', baseUrl: 'https://api.openai.com/v1' },
    });
    expect(merged?.embedding).toMatchObject({ model: 'text-embedding-3-large' });
    // chat providers untouched when only embedding is overridden
    expect(merged?.providers?.[0]?.name).toBe('default');
  });

  it('works from a null base config', () => {
    const merged = mergeLlmOverrides(null, { chat: { type: 'openai', model: 'gpt-4o' } });
    expect(merged?.providers?.[0]?.model).toBe('gpt-4o');
  });
});
