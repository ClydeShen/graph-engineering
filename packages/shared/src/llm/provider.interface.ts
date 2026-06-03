/**
 * LLM and Embedding provider interfaces — injected into Workers via iii-config.yaml.
 *
 * Workers call these interfaces and NEVER hold credentials directly.
 * Every concrete LLM call site MUST be annotated: // LLM CALL — ADR 22
 *
 * Embedding calls are NOT counted against the Worker token budget (ADR 22 D-1).
 *
 * @see ADR 22 — LLM Provider Abstraction
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface EmbedResult {
  vector: number[];
  /** Always false — embedding calls are excluded from Worker token budget (ADR 22). */
  countedAgainstBudget: false;
}

/** Synchronous text generation interface. Workers use this for all LLM calls. */
export interface LLMProvider {
  chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string>;
}

/**
 * Vector embedding interface. Workers use this for knowledge entity embeddings.
 * Results are tagged countedAgainstBudget:false — never deducted from W_max.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<EmbedResult>;
}
