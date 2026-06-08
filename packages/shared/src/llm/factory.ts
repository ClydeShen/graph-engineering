import type { LLMProvider } from './provider.interface.js';
import type { LLMProviderConfig } from './types.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';

/**
 * Factory for LLMProvider construction. Open/Closed: new providers add a case
 * here and a new file — zero changes to workers or other callers.
 *
 * @see ADR 22 — LLM Provider Abstraction
 */
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.api) {
    case 'openai-completions':
      return new OpenAICompatibleProvider(config);
    case 'anthropic-messages':
      // Phase 5 T1: replace this throw with: return new AnthropicProvider(config);
      throw new Error('AnthropicProvider not yet implemented — add in Phase 5 T1');
    default: {
      const _exhaustive: never = config.api;
      throw new Error(`Unknown LLM API: ${String(_exhaustive)}`);
    }
  }
}
