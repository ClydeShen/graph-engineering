import { describe, it, expect } from 'vitest';
import {
  PROVIDER_PROFILES,
  getProviderProfile,
  resolveProfile,
} from './provider-profiles.js';

describe('PROVIDER_PROFILES registry (ADR 56)', () => {
  it('has unique names', () => {
    const names = PROVIDER_PROFILES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every profile has a valid api selector', () => {
    for (const p of PROVIDER_PROFILES) {
      expect(['openai-completions', 'anthropic-messages']).toContain(p.api);
    }
  });

  it('anthropic does not claim embedding support (no embeddings endpoint)', () => {
    expect(getProviderProfile('anthropic')!.supportsEmbedding).toBe(false);
  });

  it('openrouter and nvidia declare embedding support (flag-drift regression guard)', () => {
    // Both were once wrongly chat-only; locking the corrected flags so a future
    // edit can't silently hide them from the embedding picker again.
    expect(getProviderProfile('openrouter')!.supportsEmbedding).toBe(true);
    expect(getProviderProfile('openrouter')!.defaultEmbeddingModel).toBe(
      'openai/text-embedding-3-small',
    );
    expect(getProviderProfile('nvidia')!.supportsEmbedding).toBe(true);
    expect(getProviderProfile('nvidia')!.defaultEmbeddingModel).toBe('baai/bge-m3');
  });

  it('embedding-capable profiles with a hosted baseUrl declare a default embedding model', () => {
    for (const p of PROVIDER_PROFILES) {
      if (p.supportsEmbedding && p.baseUrl !== undefined && !p.local) {
        expect(p.defaultEmbeddingModel, `${p.name} missing defaultEmbeddingModel`).toBeDefined();
      }
    }
  });

  it('remote key-holding profiles declare envVar and signupUrl', () => {
    for (const p of PROVIDER_PROFILES) {
      if (!p.local && p.name !== 'custom') {
        expect(p.envVar, `${p.name} missing envVar`).toBeDefined();
        expect(p.signupUrl, `${p.name} missing signupUrl`).toBeDefined();
      }
    }
  });
});

describe('resolveProfile', () => {
  it('matches by name first', () => {
    expect(resolveProfile({ name: 'ollama' }).displayName).toContain('Ollama');
  });

  it('falls back to anthropic profile via legacy type field', () => {
    expect(resolveProfile({ name: 'my-claude', type: 'anthropic' }).api).toBe(
      'anthropic-messages',
    );
  });

  it('unknown entries resolve to the custom profile (old configs keep booting)', () => {
    expect(resolveProfile({ name: 'no-such', type: 'openai-compatible' }).name).toBe('custom');
  });
});
