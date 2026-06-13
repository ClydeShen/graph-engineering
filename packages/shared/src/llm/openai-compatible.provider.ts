/**
 * OpenAI-compatible REST provider — covers ollama, llama.cpp, lmstudio, OpenAI.
 *
 * Credentials are injected via constructor from iii-config.yaml env interpolation.
 * NEVER read process.env or hardcode credentials inside a Worker — only this
 * module reads them, and only at construction time via the config object.
 *
 * @see ADR 22 — LLM Provider Abstraction
 */

import type {
  ChatMessage,
  ChatTurnResult,
  EmbedResult,
  EmbeddingProvider,
  LLMProvider,
  ToolCallingProvider,
  ToolDefinition,
} from './provider.interface.js';
import type { LLMProviderConfig } from './types.js';

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
}

export class OpenAICompatibleProvider implements LLMProvider, EmbeddingProvider, ToolCallingProvider {
  private readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  private async post(body: Record<string, unknown>): Promise<OpenAIChatResponse> {
    // LLM CALL — justified by ADR 22 (Workers call provider interface, not raw HTTP)
    const res = await fetch(`${this.config.baseUrl ?? 'http://localhost:11434'}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey ?? ''}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: this.config.maxTokens ?? 4096,
        ...body,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM chat request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as OpenAIChatResponse;
  }

  async chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string> {
    const data = await this.post({ messages, temperature: opts?.temperature ?? 0.7 });
    return data.choices[0]?.message?.content ?? '';
  }

  /** One tool-capable turn (ADR 54). Caller owns the tool loop. */
  async chatTurn(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: { temperature?: number },
  ): Promise<ChatTurnResult> {
    const data = await this.post({
      messages,
      temperature: opts?.temperature ?? 0.7,
      ...(tools.length > 0
        ? {
            tools: tools.map((t) => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    });
    const msg = data.choices[0]?.message;
    const toolCalls = (msg?.tool_calls ?? []).map((tc) => {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        /* malformed arguments — pass empty input; the tool reports its own error */
      }
      return { id: tc.id, name: tc.function.name, input };
    });
    return { text: msg?.content ?? '', toolCalls };
  }

  async embed(text: string): Promise<EmbedResult> {
    // LLM CALL — justified by ADR 22 (embedding calls excluded from Worker token budget)
    const res = await fetch(`${this.config.baseUrl ?? 'http://localhost:11434'}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey ?? ''}`,
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
      vector: padToSchemaDims(data.data[0]?.embedding ?? []),
      countedAgainstBudget: false,
    };
  }
}

/**
 * The Trail Mesh stores embeddings as vector(1536) (migration 003). Providers
 * emit whatever their model produces (BGE-M3 1024, Gemini 768, OpenAI 1536) —
 * zero-padding to the schema width keeps inserts valid and preserves cosine
 * ordering among vectors from the same model; longer vectors are truncated.
 */
const SCHEMA_EMBEDDING_DIMS = 1536;

function padToSchemaDims(vector: number[]): number[] {
  if (vector.length === 0 || vector.length === SCHEMA_EMBEDDING_DIMS) return vector;
  if (vector.length > SCHEMA_EMBEDDING_DIMS) return vector.slice(0, SCHEMA_EMBEDDING_DIMS);
  return vector.concat(new Array(SCHEMA_EMBEDDING_DIMS - vector.length).fill(0));
}
