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

/** Recent conversation messages re-projected into the prompt (≈10 exchanges). */
export const HISTORY_LIMIT = 20;

/**
 * Re-project prior conversation turns from the graph as proper chat messages
 * (ADR-54: stateless re-derivation, never a retained message list). The model
 * needs turn-structured history to stay coherent — fed only the current line it
 * repeats itself and ignores answers ("which city?" after the user already said
 * it). Excludes the just-written current turn; newest-capped, returned oldest-first.
 */
export async function loadConversationHistory(
  pool: Pool,
  scopeId: string,
  currentTurnId: string,
): Promise<ChatMessage[]> {
  const { rows } = await pool.query<{ kind: string; text: string | null }>(
    `SELECT payload::jsonb->>'kind' AS kind, payload::jsonb->>'text' AS text
       FROM execution_event_log
      WHERE scope_id = $1
        AND event_type = 'memory_updated'
        AND payload::jsonb->>'kind' IN ('conversation.user', 'conversation.assistant')
        AND payload::jsonb->>'turn_id' <> $2
      ORDER BY id DESC
      LIMIT $3`,
    [scopeId, currentTurnId, HISTORY_LIMIT],
  );
  return rows
    .reverse()
    .map((r) => ({
      role: r.kind === 'conversation.user' ? ('user' as const) : ('assistant' as const),
      content: r.text ?? '',
    }))
    .filter((m) => m.content !== '');
}

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

/**
 * Conversational system role for the ADR-54 chat surface. The agentic
 * STABLE_SYSTEM_ROLE ("you are a graph-native agent… your context window is a
 * read-time projection of the graph state") makes small models emit graph-event
 * format — they echo the trail dump and invent `[event_type] {json}` lines
 * instead of conversing — so the conversation surface gets its own prose-first
 * instruction. (The agentic role is unchanged for the real agent path.)
 *
 * DELIBERATELY a single hand-tuned string, NOT a hermes-style guidance registry
 * keyed on (model family) × (tools present). That seam is deferred until a
 * second real case appears — today the chat path has one model class (small
 * local) and zero external tools. Two tripwires guard the deferral so it stays
 * safe rather than forgotten:
 *
 *   - HARD (tool axis): the "you have NO … tools" claim below becomes a LIE the
 *     moment chat gains a real tool (#17 MCP ecosystem). A test asserts that
 *     claim (core.test.ts "TRIPWIRE: role claims no external access") — it fails
 *     when the claim is removed, forcing whoever wires a tool to make the role
 *     capability-aware instead of silently lying.
 *   - SOFT (model-family axis): if you're about to append a FOURTH small-model
 *     pathology patch to this string, STOP — that's the signal to extract named
 *     guidance blocks (see hermes agent/prompt_builder.py: TASK_COMPLETION_
 *     GUIDANCE, TOOL_USE_ENFORCEMENT_GUIDANCE) rather than grow this wall.
 *     Patches so far: (1) prose-first anti-parroting, (2) anti-confabulation,
 *     (3) no-label/honesty. Three. The next one triggers the extraction.
 */
export const CONVERSATION_SYSTEM_ROLE =
  'You are the memex, a conversational assistant backed by a persistent graph memory. ' +
  'You have NO access to the live internet, weather, location, clocks, or any external ' +
  'data source, and no ability to call APIs, browse, or run tools — unless a tool RESULT ' +
  'is explicitly provided to you in this conversation. ' +
  'Never fabricate facts, data, sources, tool calls, or API requests, and never claim to ' +
  'have looked something up or accessed anything. If you lack the information or the ' +
  'ability to obtain it, say so plainly and briefly instead of inventing an answer — ' +
  'reporting a blocker honestly is always better than inventing a result. ' +
  'Only state things you actually know or that appear in this conversation. ' +
  'Reply directly and naturally, in prose. Do not prefix your reply with labels or section ' +
  'headers (e.g. never start a line with "MEMORY", "(MEMORY)", or "##"). Any background-memory ' +
  'section below is recalled from earlier trails for your private reference — draw on it silently ' +
  'when relevant; never quote it, list it, echo its heading, or mention that it exists.';

/**
 * Prose memory block for the conversation prompt: crystallized lessons,
 * capability notes, and CCR retrieval guidance. Deliberately EXCLUDES the raw
 * trail-event listing — small models parrot it — and the conversation turns,
 * which are re-projected as real chat messages (see loadConversationHistory).
 *
 * The block is framed as internal, non-displayable reference rather than a
 * markdown "## MEMORY" heading: an 8b model echoed that heading back as a
 * "(MEMORY) …" reply prefix (observed live). A self-labelling prose frame is
 * less imitable than a section header.
 */
export function conversationMemoryBlock(ctx: AssembledContext): string {
  const parts: string[] = [];
  if (ctx.reflectionContent !== undefined && ctx.reflectionContent !== '') {
    parts.push(ctx.reflectionContent);
  }
  if (ctx.capabilityContent !== undefined && ctx.capabilityContent !== '') {
    parts.push(ctx.capabilityContent);
  }
  if (ctx.ccrInstructions !== undefined) parts.push(ctx.ccrInstructions);
  if (parts.length === 0) return '';
  return (
    '(Background memory recalled from earlier trails — for your private reference only. ' +
    'Do not display, quote, or mention this. Draw on it silently if relevant.)\n' +
    parts.join('\n\n')
  );
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
  const systemParts: string[] = [CONVERSATION_SYSTEM_ROLE];
  if (ctx !== null) {
    const mem = conversationMemoryBlock(ctx);
    if (mem !== '') systemParts.push(mem);
  }
  // Prior turns as real chat messages (not buried in the system trail-dump, where
  // small models can't follow them). baseMessages is the clean prompt the
  // tool-loop fallback re-asks from.
  const history = await loadConversationHistory(deps.pool, input.scopeId, turnId);
  const baseMessages: ChatMessage[] = [
    ...(systemParts.length > 0
      ? [{ role: 'system' as const, content: systemParts.join('\n\n') }]
      : []),
    ...history,
    { role: 'user' as const, content: input.text },
  ];
  const messages: ChatMessage[] = [...baseMessages];

  // 3. Chat with the memex_retrieve tool (ADR 54 D-3): honours the stable
  // system prompt's promise that dropped events are retrievable. Offered ONLY
  // when CCR actually dropped events — otherwise there is nothing to retrieve,
  // and small models reflexively emit empty-prose tool calls (or leak the tool
  // JSON as text) on a cold/short conversation. No drops → plain chat.
  const hasDroppedContext = ctx !== null && ctx.droppedCount > 0;
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
    if (supportsToolTurns(deps.chat) && hasDroppedContext) {
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
      // Plain chat: provider has no tool support, or nothing was dropped so the
      // retrieve tool would only invite small-model pathologies (ADR 22).
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
