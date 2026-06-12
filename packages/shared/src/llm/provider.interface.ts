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

import type { ChatMessage } from './types.js';
export type { ChatMessage };

export interface EmbedResult {
  vector: number[];
  /** Always false — embedding calls are excluded from Worker token budget (ADR 22). */
  countedAgainstBudget: false;
}

/** Synchronous text generation interface. Workers use this for all LLM calls. */
export interface LLMProvider {
  chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string>;
}

// ── Tool-calling turn surface (ADR 54 conversation core) ─────────────────────

/** Provider-agnostic tool definition (JSON-schema input). */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** One tool invocation requested by the model. */
export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
}

/** Result of a single tool-capable chat turn. */
export interface ChatTurnResult {
  text: string;
  toolCalls: ToolCallRequest[];
}

/**
 * Optional capability: one chat turn that may request tool calls. The caller
 * owns the loop (execute tools, fold results back in, call again). Implemented
 * by both concrete providers; detect with supportsToolTurns().
 */
export interface ToolCallingProvider {
  chatTurn(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: { temperature?: number },
  ): Promise<ChatTurnResult>;
}

/** Type guard for the optional tool-turn capability. */
export function supportsToolTurns(p: LLMProvider): p is LLMProvider & ToolCallingProvider {
  return typeof (p as Partial<ToolCallingProvider>).chatTurn === 'function';
}

/**
 * Vector embedding interface. Workers use this for knowledge entity embeddings.
 * Results are tagged countedAgainstBudget:false — never deducted from W_max.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<EmbedResult>;
}
