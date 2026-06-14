import { describe, it, expect } from 'vitest';
import { resolveChannelProvider, type MemexConfig } from './loader.js';
import { buildChannelChatProvider } from '../llm/from-config.js';

const cfg: MemexConfig = {
  providers: [
    { name: 'fast', type: 'openai', model: 'gpt-x', priority: 1 },
    { name: 'local', type: 'ollama', model: 'qwen', priority: 2 },
  ],
  channels: {
    telegram: { token: 't', llm: 'local' },
    slack: { token: 's' }, // no llm override → falls back to global default
  },
};

describe('resolveChannelProvider (CONSOLE-REDESIGN §11.2 per-channel LLM)', () => {
  it('returns the provider named by the channel llm field', () => {
    expect(resolveChannelProvider(cfg, 'telegram')?.name).toBe('local');
  });

  it('returns undefined when the channel has no llm override', () => {
    expect(resolveChannelProvider(cfg, 'slack')).toBeUndefined();
  });

  it('returns undefined for an unknown channel or null config', () => {
    expect(resolveChannelProvider(cfg, 'discord')).toBeUndefined();
    expect(resolveChannelProvider(null, 'telegram')).toBeUndefined();
  });

  it('returns undefined when llm references a missing provider', () => {
    const bad: MemexConfig = { providers: [], channels: { x: { llm: 'ghost' } } };
    expect(resolveChannelProvider(bad, 'x')).toBeUndefined();
  });
});

describe('buildChannelChatProvider (per-channel agent identity)', () => {
  it('builds a provider for a channel with an llm override', () => {
    const p = buildChannelChatProvider(cfg, 'telegram');
    expect(p).not.toBeNull();
    expect(typeof p?.chat).toBe('function');
  });

  it('returns null when the channel has no override (caller uses default)', () => {
    expect(buildChannelChatProvider(cfg, 'slack')).toBeNull();
    expect(buildChannelChatProvider(cfg, 'discord')).toBeNull();
    expect(buildChannelChatProvider(null, 'telegram')).toBeNull();
  });
});
