/**
 * Anthropic Messages API provider.
 *
 * Uses raw fetch() — no @anthropic-ai/sdk dep.
 * Does NOT implement EmbeddingProvider — Anthropic has no embeddings endpoint.
 * Embedding is always handled by OpenAICompatibleProvider (wired in workers/index.ts).
 *
 * @see ADR 22 — LLM Provider Abstraction
 */

import type { ChatMessage, LLMProvider } from './provider.interface.js';
import type { LLMProviderConfig } from './types.js';

export class AnthropicProvider implements LLMProvider {
  private readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  async chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string> {
    // LLM CALL — justified by ADR 22 (Workers call provider interface, not raw HTTP)
    const baseUrl = this.config.baseUrl ?? 'https://api.anthropic.com';
    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey ?? '',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 4096,
        messages,
        temperature: opts?.temperature ?? 0.7,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic chat request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { content: Array<{ type: string; text: string }> };
    return data.content.find(b => b.type === 'text')?.text ?? '';
  }
}
