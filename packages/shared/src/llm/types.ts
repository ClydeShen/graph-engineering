/**
 * LLM provider type definitions — Pi SDK naming alignment.
 *
 * LLMProviderConfig explicitly extends Pi SDK ProviderConfig for baseUrl/apiKey
 * so that any breaking change to those fields surfaces as a compile error here.
 *
 * LLMApi mirrors Pi SDK ProviderConfig.api field naming.
 * ChatMessage is LLM wire format (NOT Pi SDK AgentMessage).
 *
 * @see Pi SDK AgentMessage for session-management types (user/assistant/toolResult — no system role).
 * @see ADR 22 — LLM Provider Abstraction
 */

import type { ProviderConfig as PiProviderConfig } from '@earendil-works/pi-coding-agent';

/**
 * LLM API protocol selector. Mirrors Pi SDK ProviderConfig.api naming.
 *
 * 'openai-completions' covers all OpenAI-compatible endpoints:
 *   OpenAI, Ollama, vLLM, LM Studio, DeepSeek.
 * 'anthropic-messages' targets the Anthropic Messages API.
 * Phase 7+: extend with '| google-gemini' — add branch in factory, new file, zero worker changes.
 */
export type LLMApi = 'openai-completions' | 'anthropic-messages';

/**
 * Unified provider config. Workers never read this directly —
 * constructed at the boot entry point (workers/index.ts) and injected.
 *
 * Extends Pi SDK ProviderConfig for baseUrl/apiKey (type-level link, no runtime dep).
 * api: required LLMApi narrows Pi SDK's optional Api.
 * model: per-call string (Pi SDK uses models[] registry array on ProviderModelConfig).
 * maxTokens: per-call limit (Pi SDK ProviderModelConfig.maxTokens is a registry field).
 */
export interface LLMProviderConfig extends Pick<PiProviderConfig, 'baseUrl' | 'apiKey'> {
  /** Protocol selector — required; narrows Pi SDK ProviderConfig.api (optional). */
  api: LLMApi;
  /** Model identifier — Pi SDK ProviderModelConfig.id naming. */
  model: string;
  /** Max output tokens — Pi SDK ProviderModelConfig.maxTokens. Default: 4096. */
  maxTokens?: number;
}

/**
 * LLM wire format message. NOT Pi SDK AgentMessage.
 *
 * Keeps 'system' role — Pi SDK handles system prompts at the session-management
 * layer and has no system role in its AgentMessage union type.
 *
 * @see Pi SDK AgentMessage for UserMessage / AssistantMessage / ToolResultMessage.
 * @see Phase 7+: @graph/types TextContent unification with Pi SDK TextContent = {type:'text',text:string}.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
