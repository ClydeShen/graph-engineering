/**
 * Conversation core (ADR 54) — gateway-side stateless reply loop, the MemexShell seed.
 *
 * Per turn: user message → OCC write into the graph → processAgentTurn context
 * projection (Graph → Context, never Context = State) → chat LLM (fallback
 * chain) with the memex_retrieve tool → assistant turn written back to the
 * graph. The core holds NO message list — every turn re-projects from the
 * Trail Mesh.
 *
 * Conversation turns are recorded as memory_updated events with
 * kind:'conversation.user' / 'conversation.assistant' payloads (the unique
 * turn_id keeps the TD-B dedup window from eating repeated greetings).
 * They intentionally do NOT spawn required_skills tasks — skill routing is
 * for asynchronous agentic work (ADR 54 D-4), not for chat.
 *
 * @see docs/adr/0063-adr54-conversation-core.md
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  occWrite,
  supportsToolTurns,
  type ChatMessage,
  type EmbeddingProvider,
  type LLMProvider,
  type ToolDefinition,
} from '@graph/shared';
import { logger } from '@shared/logger';
import {
  createCcrStore,
  createMemexRetrieveTool,
  createMemexRetrieveExecute,
  MEMEX_RETRIEVE_TOOL_NAME,
} from '@graph/workers/context/ccr';
import type { AssembledContext } from '@graph/workers/context/assemble';
import { processAgentTurn } from '../process-agent-turn.js';

const log = logger.child({ component: 'gateway', module: 'conversation-core' });

/** Hard cap on retrieve→re-ask iterations per turn. */
export const MAX_TOOL_ITERATIONS = 3;

export interface ConversationDeps {
  pool: Pool;
  wMax: number;
  embed: EmbeddingProvider | null;
  /** null = not configured: the turn fails fast with guidance, never hangs. */
  chat: LLMProvider | null;
}

export interface ConversationTurnInput {
  scopeId: string;
  text: string;
  /** Requesting principal (ADR-46 attribution). */
  principal?: string;
  /** Streaming sink — receives reply text chunks as they become available. */
  onDelta?: (text: string) => void;
}

export type ConversationTurnResult =
  | { kind: 'reply'; reply: string; user_version_hash: string; assistant_version_hash: string }
  | { kind: 'suspended' }
  | { kind: 'error'; message: string };

/** Serialize the context projection into a compact prompt block. */
export function formatContextBlock(ctx: AssembledContext): string {
  const parts: string[] = [];
  if (ctx.reflectionContent !== undefined && ctx.reflectionContent !== '') {
    parts.push(ctx.reflectionContent);
  }
  if (ctx.capabilityContent !== undefined && ctx.capabilityContent !== '') {
    parts.push(ctx.capabilityContent);
  }
  if (ctx.context !== null && ctx.context.length > 0) {
    const lines = ctx.context.map((e) => {
      if ('_ccr_dropped' in e) return e._ccr_dropped;
      return `[${e.event_type}] ${typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload)}`;
    });
    parts.push('## Trail Context (newest last)\n' + lines.join('\n'));
  }
  if (ctx.ccrInstructions !== undefined) parts.push(ctx.ccrInstructions);
  return parts.join('\n\n');
}

/**
 * Run one conversation turn. Stateless: everything derives from the graph and
 * returns to the graph; the only in-process state is the turn-scoped CCR store.
 */
export async function runConversationTurn(
  deps: ConversationDeps,
  input: ConversationTurnInput,
): Promise<ConversationTurnResult> {
  if (deps.chat === null) {
    return {
      kind: 'error',
      message: 'no chat provider configured — run `memex onboard` (or set LLM_* env vars)',
    };
  }

  // Tip lookup: the gateway owns predecessor tracking for conversation turns —
  // thin clients (terminal, channel bots) never juggle hashes.
  const { rows: tipRows } = await deps.pool.query<{ version_hash: string }>(
    'SELECT version_hash FROM execution_event_log WHERE scope_id = $1 ORDER BY id DESC LIMIT 1',
    [input.scopeId],
  );
  if (tipRows.length === 0) {
    return { kind: 'error', message: `unknown scope: ${input.scopeId}` };
  }

  // 1. User turn into the graph (trail = SSOT), with context projection.
  const ccrStore = createCcrStore();
  const turnId = randomUUID();
  const userOutcome = await processAgentTurn(
    deps.pool,
    input.scopeId,
    {
      entity_id: randomUUID(),
      event_type: 'memory_updated',
      predecessor_hash: tipRows[0]!.version_hash,
      payload: { kind: 'conversation.user', turn_id: turnId, text: input.text },
    },
    deps.wMax,
    deps.embed,
    input.principal,
    ccrStore,
  );

  if (userOutcome.suspended) return { kind: 'suspended' };
  if ('deduplicated' in userOutcome && userOutcome.deduplicated) {
    return { kind: 'error', message: 'duplicate message (dedup window)' };
  }

  // 2. Build the prompt from the projection. A degraded turn (context null
  // from an environment fault, ADR 55) still converses — with less context.
  const ctx = userOutcome.context;
  const systemParts: string[] = [];
  if (ctx !== null) {
    systemParts.push(ctx.stable);
    const block = formatContextBlock(ctx);
    if (block !== '') systemParts.push(block);
  }
  const messages: ChatMessage[] = [
    ...(systemParts.length > 0
      ? [{ role: 'system' as const, content: systemParts.join('\n\n') }]
      : []),
    { role: 'user' as const, content: input.text },
  ];

  // 3. Chat with the memex_retrieve tool (ADR 54 D-3): honours the stable
  // system prompt's promise that dropped events are retrievable.
  const retrieveTool = createMemexRetrieveTool();
  const tools: ToolDefinition[] = [
    {
      name: retrieveTool.name,
      description: retrieveTool.description,
      inputSchema: retrieveTool.input_schema as unknown as Record<string, unknown>,
    },
  ];
  const executeRetrieve = createMemexRetrieveExecute(ccrStore);

  let reply: string;
  try {
    if (supportsToolTurns(deps.chat)) {
      // Snapshot the clean prompt (system + user) before the loop folds tool
      // results into `messages` — the empty-reply fallback re-asks from here.
      const baseMessages = [...messages];
      let turn = await deps.chat.chatTurn(messages, tools);
      let iterations = 0;
      while (turn.toolCalls.length > 0 && iterations < MAX_TOOL_ITERATIONS) {
        iterations++;
        for (const call of turn.toolCalls) {
          const args = (call.input ?? {}) as { hash?: string; query?: string };
          const result =
            call.name === MEMEX_RETRIEVE_TOOL_NAME
              ? await executeRetrieve({ hash: args.hash ?? '', ...(args.query !== undefined ? { query: args.query } : {}) })
              : { error: `unknown tool: ${call.name}` };
          // Tool results are folded back as plain text — single-tool loop, no
          // provider-specific tool-message protocol needed (ADR 54 v1 scope).
          messages.push(
            { role: 'assistant', content: turn.text !== '' ? turn.text : `(requested ${call.name})` },
            { role: 'user', content: `Tool result for ${call.name}: ${JSON.stringify(result)}` },
          );
        }
        turn = await deps.chat.chatTurn(messages, tools);
      }
      reply = turn.text;
      // A small model (e.g. llama-3.1-8b) reflexively emits a memex_retrieve
      // tool call with EMPTY prose — even for a plain greeting — and can keep
      // doing so until the iteration budget is spent, leaving reply=''. That
      // surfaced as a silent no-response in the terminal (the assistant text
      // only renders via streamed deltas, and an empty reply streams nothing).
      // Force one final tool-free turn so the model must answer in prose.
      // Re-ask from the clean prompt, not the tool-polluted `messages` — reaching
      // here means the tool path never converged, and feeding the failed-retrieval
      // transcript back makes the model narrate its failures ("three consecutive
      // failed attempts…") instead of answering the user.
      if (reply.trim() === '') {
        reply = await deps.chat.chat(baseMessages);
      }
    } else {
      // LLM CALL — ADR 22 (provider without tool support: plain chat)
      reply = await deps.chat.chat(messages);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ scope_id: input.scopeId, err: message }, 'conversation.llm.error');
    return { kind: 'error', message: `LLM call failed: ${message}` };
  }

  // 4. Stream the reply. Single-delta degenerate stream until providers gain
  // token streaming — the protocol slot (ADR-44 text_delta) is now live.
  if (reply !== '') input.onDelta?.(reply);

  // 5. Assistant turn back into the graph. Direct OCC write — no second
  // context assembly (the next user turn re-projects anyway).
  const assistantWrite = await occWrite(deps.pool, {
    scopeId: input.scopeId,
    entityId: randomUUID(),
    predecessorHash: userOutcome.version_hash,
    eventType: 'memory_updated',
    payload: { kind: 'conversation.assistant', turn_id: turnId, text: reply },
  });

  return {
    kind: 'reply',
    reply,
    user_version_hash: userOutcome.version_hash,
    assistant_version_hash: assistantWrite.version_hash,
  };
}
