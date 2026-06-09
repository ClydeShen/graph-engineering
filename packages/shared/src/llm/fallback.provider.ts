/**
 * FallbackProvider — circuit-breaker for LLM provider failover.
 *
 * Transparently retries on the next provider in priority order for transient
 * errors, and immediately surfaces fatal errors (auth, context_length,
 * content_filter) without wasting a failover attempt.
 *
 * @see ADR 22 — LLM Provider Abstraction
 * @see classifyProviderError for error classification logic
 */

import type { LLMProvider, ChatMessage } from './provider.interface.js';
import { classifyProviderError } from './classify-error.js';

/** A named provider with a priority (lower number = higher priority). */
export interface ProviderEntry {
  name: string;
  provider: LLMProvider;
  priority: number;
}

/** Thrown when all providers in the FallbackProvider list have been exhausted. */
export class AllProvidersExhaustedError extends Error {
  constructor() {
    super('All LLM providers exhausted');
    this.name = 'AllProvidersExhaustedError';
  }
}

/**
 * FallbackProvider implements LLMProvider by delegating to an ordered list of
 * concrete providers. On transient failure, it advances to the next provider.
 * On fatal failure, it re-throws immediately.
 */
export class FallbackProvider implements LLMProvider {
  private readonly sorted: ProviderEntry[];

  constructor(providers: ProviderEntry[]) {
    // Sort ascending by priority (1 = highest priority); do not mutate input
    this.sorted = [...providers].sort((a, b) => a.priority - b.priority);
  }

  async chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string> {
    for (const entry of this.sorted) {
      try {
        // LLM CALL — justified by ADR 22 (Workers call provider interface, not raw HTTP)
        const result = await entry.provider.chat(messages, opts);
        return result;
      } catch (err) {
        const classified = classifyProviderError(err);
        if (classified.shouldThrow) {
          throw classified.original;
        }
        // classified.shouldFailover — continue to next provider
      }
    }
    throw new AllProvidersExhaustedError();
  }
}
