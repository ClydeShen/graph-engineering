import { describe, it, expect } from 'vitest';
import { buildChatProvider, buildEmbeddingProvider } from './from-config.js';
import { FallbackProvider } from './fallback.provider.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';
import { AnthropicProvider } from './anthropic.provider.js';
import type { MemexConfig } from '../config/loader.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe('buildChatProvider (ADR 56)', () => {
  it('single config entry builds a concrete provider via its profile', () => {
    const cfg: MemexConfig = {
      providers: [{ name: 'anthropic', type: 'anthropic', model: 'claude-sonnet-4-6', priority: 1, apiKey: 'k' }],
    };
    expect(buildChatProvider(cfg, EMPTY_ENV)).toBeInstanceOf(AnthropicProvider);
  });

  it('multiple entries become a FallbackProvider chain', () => {
    const cfg: MemexConfig = {
      providers: [
        { name: 'anthropic', type: 'anthropic', model: 'claude-sonnet-4-6', priority: 1, apiKey: 'k' },
        { name: 'ollama', type: 'openai-compatible', model: 'llama3', priority: 2 },
      ],
    };
    expect(buildChatProvider(cfg, EMPTY_ENV)).toBeInstanceOf(FallbackProvider);
  });

  it('no config falls back to legacy env construction', () => {
    const provider = buildChatProvider(null, {
      LLM_MODEL: 'llama3',
      LLM_BASE_URL: 'http://localhost:11434',
    } as NodeJS.ProcessEnv);
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('profile default baseUrl applies when entry omits it', () => {
    const cfg: MemexConfig = {
      providers: [{ name: 'deepseek', type: 'openai-compatible', model: 'deepseek-chat', priority: 1, apiKey: 'k' }],
    };
    // No baseUrl on entry — must not throw; profile supplies https://api.deepseek.com
    expect(() => buildChatProvider(cfg, EMPTY_ENV)).not.toThrow();
  });
});

describe('buildEmbeddingProvider (ADR 55/56 — nullable by design)', () => {
  it('explicit embedding section wins', () => {
    const cfg: MemexConfig = {
      providers: [{ name: 'anthropic', type: 'anthropic', model: 'm', priority: 1 }],
      embedding: { baseUrl: 'http://localhost:11434', model: 'nomic-embed-text' },
    };
    expect(buildEmbeddingProvider(cfg, EMPTY_ENV)).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('embedding section can reference a profile by name', () => {
    const cfg: MemexConfig = {
      embedding: { provider: 'ollama' }, // baseUrl + defaultEmbeddingModel from profile
    };
    expect(buildEmbeddingProvider(cfg, EMPTY_ENV)).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('derives from the first embedding-capable chat provider', () => {
    const cfg: MemexConfig = {
      providers: [
        { name: 'anthropic', type: 'anthropic', model: 'm', priority: 1 },
        { name: 'ollama', type: 'openai-compatible', model: 'llama3', priority: 2 },
      ],
    };
    expect(buildEmbeddingProvider(cfg, EMPTY_ENV)).toBeInstanceOf(OpenAICompatibleProvider);
  });

  it('Anthropic-only config yields null (degraded mode), NOT a broken default', () => {
    const cfg: MemexConfig = {
      providers: [{ name: 'anthropic', type: 'anthropic', model: 'claude-sonnet-4-6', priority: 1 }],
    };
    expect(buildEmbeddingProvider(cfg, EMPTY_ENV)).toBeNull();
  });

  it('never uses the chat model as an implicit embedding model', () => {
    // vllm supports embedding but has no defaultEmbeddingModel and no EMBEDDING_MODEL env:
    // deriving would require inventing a model — must return null instead.
    const cfg: MemexConfig = {
      providers: [{ name: 'vllm', type: 'openai-compatible', model: 'some-chat-model', priority: 1 }],
    };
    expect(buildEmbeddingProvider(cfg, EMPTY_ENV)).toBeNull();
  });

  it('legacy env-only boot requires an explicit LLM_BASE_URL', () => {
    expect(buildEmbeddingProvider(null, EMPTY_ENV)).toBeNull();
    expect(
      buildEmbeddingProvider(null, {
        LLM_BASE_URL: 'http://localhost:11434',
        EMBEDDING_MODEL: 'nomic-embed-text',
      } as NodeJS.ProcessEnv),
    ).toBeInstanceOf(OpenAICompatibleProvider);
  });
});
