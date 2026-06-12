/**
 * Anthropic Messages API provider.
 *
 * Uses raw fetch() — no @anthropic-ai/sdk dep.
 * Does NOT implement EmbeddingProvider — Anthropic has no embeddings endpoint.
 * Embedding is always handled by OpenAICompatibleProvider (wired in workers/index.ts).
 *
 * System messages: the Messages API rejects role:'system' inside messages[] —
 * they are extracted into the top-level `system` parameter here, so callers
 * keep using the unified ChatMessage shape.
 *
 * @see ADR 22 — LLM Provider Abstraction
 */

import type {
  ChatMessage,
  ChatTurnResult,
  LLMProvider,
  ToolCallingProvider,
  ToolDefinition,
} from './provider.interface.js';
import type { LLMProviderConfig } from './types.js';

interface AnthropicResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
}

/** Split unified messages into Anthropic's top-level system + user/assistant turns. */
function splitSystem(messages: ChatMessage[]): { system: string; turns: ChatMessage[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const turns = messages.filter((m) => m.role !== 'system');
  return { system, turns };
}

export class AnthropicProvider implements LLMProvider, ToolCallingProvider {
  private readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }

  private async post(body: Record<string, unknown>): Promise<AnthropicResponse> {
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
        ...body,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic chat request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as AnthropicResponse;
  }

  async chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string> {
    const { system, turns } = splitSystem(messages);
    const data = await this.post({
      messages: turns,
      temperature: opts?.temperature ?? 0.7,
      ...(system !== '' ? { system } : {}),
    });
    const block = data.content.find((b) => b.type === 'text');
    return block !== undefined && block.type === 'text' ? block.text : '';
  }

  /** One tool-capable turn (ADR 54). Caller owns the tool loop. */
  async chatTurn(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    opts?: { temperature?: number },
  ): Promise<ChatTurnResult> {
    const { system, turns } = splitSystem(messages);
    const data = await this.post({
      messages: turns,
      temperature: opts?.temperature ?? 0.7,
      ...(system !== '' ? { system } : {}),
      ...(tools.length > 0
        ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) }
        : {}),
    });
    let text = '';
    const toolCalls: ChatTurnResult['toolCalls'] = [];
    for (const block of data.content) {
      if (block.type === 'text') text += block.text;
      else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }
    return { text, toolCalls };
  }
}
