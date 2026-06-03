/**
 * OpenAI-compatible REST provider — covers ollama, llama.cpp, lmstudio, OpenAI.
 *
 * Credentials are injected via constructor from iii-config.yaml env interpolation.
 * NEVER read process.env or hardcode credentials inside a Worker — only this
 * module reads them, and only at construction time via the config object.
 *
 * @see ADR 22 — LLM Provider Abstraction
 */

import type { ChatMessage, EmbedResult, EmbeddingProvider, LLMProvider } from './provider.interface.js';

export interface ProviderConfig {
  /** Base URL, e.g. http://localhost:11434 (ollama) or https://api.openai.com */
  baseUrl: string;
  /** Model name, e.g. "llama3" or "gpt-4o" */
  model: string;
  /** API key — sourced from iii-config.yaml env interpolation, never a literal */
  apiKey: string;
}

export class OpenAICompatibleProvider implements LLMProvider, EmbeddingProvider {
  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string> {
    // LLM CALL — justified by ADR 22 (Workers call provider interface, not raw HTTP)
    const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: opts?.temperature ?? 0.7,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM chat request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    return data.choices[0]?.message?.content ?? '';
  }

  async embed(text: string): Promise<EmbedResult> {
    // LLM CALL — justified by ADR 22 (embedding calls excluded from Worker token budget)
    const res = await fetch(`${this.config.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        input: text,
      }),
    });

    if (!res.ok) {
      throw new Error(`Embedding request failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return {
      vector: data.data[0]?.embedding ?? [],
      countedAgainstBudget: false,
    };
  }
}
