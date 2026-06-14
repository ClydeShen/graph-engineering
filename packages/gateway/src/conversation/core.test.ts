/**
 * Conversation core tests (ADR 54): graph-projected, stateless reply loop.
 * processAgentTurn and occWrite are mocked — this tests the core's own logic:
 * provider gating, projection→prompt assembly, tool loop, write-back order.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import type { ChatMessage, ToolDefinition } from '@graph/shared';

const processAgentTurn = vi.fn();
const occWrite = vi.fn();

vi.mock('../process-agent-turn.js', () => ({
  processAgentTurn: (...a: unknown[]) => processAgentTurn(...a),
}));
vi.mock('@graph/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@graph/shared')>();
  return { ...actual, occWrite: (...a: unknown[]) => occWrite(...a) };
});

import {
  runConversationTurn,
  conversationMemoryBlock,
  CONVERSATION_SYSTEM_ROLE,
  MAX_TOOL_ITERATIONS,
} from './core.js';
import type { AssembledContext } from '@graph/workers/context/assemble';

function makePool(tipRows: unknown[] = [{ version_hash: 't'.repeat(64) }]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows: tipRows }) } as unknown as Pool;
}

const baseContext: AssembledContext = {
  stable: 'STABLE',
  context: [],
  volatile: '{}',
  ccrHashes: [],
  droppedCount: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  processAgentTurn.mockResolvedValue({
    suspended: false,
    version_hash: 'u'.repeat(64),
    occ_result: 'won',
    context: baseContext,
  });
  occWrite.mockResolvedValue({ version_hash: 'a'.repeat(64), occ_result: 'won', event_type: 'memory_updated' });
});

/** Override the next turn's projection to report dropped context (droppedCount>0),
 *  the precondition for offering the memex_retrieve tool. */
function withDroppedContext(): void {
  processAgentTurn.mockResolvedValueOnce({
    suspended: false,
    version_hash: 'u'.repeat(64),
    occ_result: 'won',
    context: { ...baseContext, droppedCount: 1 },
  });
}

describe('runConversationTurn', () => {
  it('null chat provider fails fast with onboarding guidance', async () => {
    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat: null },
      { scopeId: 's1', text: 'hi' },
    );
    expect(result).toMatchObject({ kind: 'error' });
    expect((result as { message: string }).message).toContain('memex onboard');
  });

  it('unknown scope fails fast (no tip row)', async () => {
    const chat = { chat: vi.fn() };
    const result = await runConversationTurn(
      { pool: makePool([]), wMax: 4096, embed: null, chat },
      { scopeId: 'nope', text: 'hi' },
    );
    expect(result).toMatchObject({ kind: 'error' });
  });

  it('happy path: user write → LLM → delta → assistant write-back', async () => {
    const chat = { chat: vi.fn().mockResolvedValue('hello there') };
    const deltas: string[] = [];
    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi', onDelta: (t) => deltas.push(t) },
    );

    expect(result).toEqual({
      kind: 'reply',
      reply: 'hello there',
      user_version_hash: 'u'.repeat(64),
      assistant_version_hash: 'a'.repeat(64),
    });
    expect(deltas).toEqual(['hello there']);

    // User turn recorded as conversation.user memory_updated, no required_skills (D-4)
    const userEvent = processAgentTurn.mock.calls[0]![2] as { event_type: string; payload: Record<string, unknown> };
    expect(userEvent.event_type).toBe('memory_updated');
    expect(userEvent.payload['kind']).toBe('conversation.user');
    expect(userEvent.payload['required_skills']).toBeUndefined();

    // Assistant write chains on the user turn's hash
    const writeArgs = occWrite.mock.calls[0]![1] as { predecessorHash: string; payload: Record<string, unknown> };
    expect(writeArgs.predecessorHash).toBe('u'.repeat(64));
    expect(writeArgs.payload['kind']).toBe('conversation.assistant');
  });

  it('conversational role + lessons land in the system message (no raw trail dump)', async () => {
    processAgentTurn.mockResolvedValue({
      suspended: false,
      version_hash: 'u'.repeat(64),
      occ_result: 'won',
      context: {
        ...baseContext,
        reflectionContent: 'REFLECTED-LESSONS',
        context: [{ event_type: 'plan_created', payload: '{"intent":"x"}' }],
      },
    });
    const chat = { chat: vi.fn().mockResolvedValue('ok') };
    await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi' },
    );
    const messages = chat.chat.mock.calls[0]![0] as ChatMessage[];
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain(CONVERSATION_SYSTEM_ROLE);
    expect(messages[0]!.content).toContain('REFLECTED-LESSONS');
    // Raw trail events must not be dumped into the conversation prompt (parroting).
    expect(messages[0]!.content).not.toContain('plan_created');
    // The agentic graph-projection role must not leak into the chat surface.
    expect(messages[0]!.content).not.toContain('graph-native agent');
  });

  it('suspended scope propagates', async () => {
    processAgentTurn.mockResolvedValue({ suspended: true });
    const chat = { chat: vi.fn() };
    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi' },
    );
    expect(result).toEqual({ kind: 'suspended' });
    expect(chat.chat).not.toHaveBeenCalled();
  });

  it('degraded turn (context null from environment fault) still converses', async () => {
    processAgentTurn.mockResolvedValue({
      suspended: false,
      version_hash: 'u'.repeat(64),
      occ_result: 'won',
      context: null,
    });
    const chat = { chat: vi.fn().mockResolvedValue('still here') };
    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi' },
    );
    expect(result).toMatchObject({ kind: 'reply', reply: 'still here' });
  });

  it('tool loop: memex_retrieve call is executed and folded back', async () => {
    withDroppedContext(); // tool is only offered when CCR actually dropped events
    const chatTurn = vi
      .fn()
      .mockResolvedValueOnce({
        text: '',
        toolCalls: [{ id: '1', name: 'memex_retrieve', input: { hash: 'h1' } }],
      })
      .mockResolvedValueOnce({ text: 'final answer', toolCalls: [] });
    const chat = { chat: vi.fn(), chatTurn };

    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi' },
    );

    expect(result).toMatchObject({ kind: 'reply', reply: 'final answer' });
    expect(chatTurn).toHaveBeenCalledTimes(2);
    // Tool result folded into the second call's messages
    const secondMessages = chatTurn.mock.calls[1]![0] as ChatMessage[];
    expect(secondMessages.some((m) => m.content.includes('Tool result for memex_retrieve'))).toBe(true);
    // Tool definitions passed through
    const tools = chatTurn.mock.calls[0]![1] as ToolDefinition[];
    expect(tools[0]!.name).toBe('memex_retrieve');
  });

  it('tool loop is capped at MAX_TOOL_ITERATIONS', async () => {
    withDroppedContext();
    const chatTurn = vi.fn().mockResolvedValue({
      text: 'loop',
      toolCalls: [{ id: 'x', name: 'memex_retrieve', input: { hash: 'h' } }],
    });
    const chat = { chat: vi.fn(), chatTurn };

    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi' },
    );

    expect(result).toMatchObject({ kind: 'reply' });
    expect(chatTurn).toHaveBeenCalledTimes(MAX_TOOL_ITERATIONS + 1);
  });

  it('empty prose after the tool loop falls back to a tool-free turn', async () => {
    // Small models (llama-3.1-8b) reflexively call memex_retrieve with empty
    // text every turn — without the fallback, reply='' renders as a silent
    // no-response in the terminal. The fallback forces a final tool-free chat().
    withDroppedContext();
    const chatTurn = vi.fn().mockResolvedValue({
      text: '',
      toolCalls: [{ id: 'x', name: 'memex_retrieve', input: { query: 'greeting' } }],
    });
    const chat = { chat: vi.fn().mockResolvedValue('forced final answer'), chatTurn };

    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'greeting' },
    );

    expect(result).toMatchObject({ kind: 'reply', reply: 'forced final answer' });
    expect(chat.chat).toHaveBeenCalledTimes(1); // tool-free fallback fired exactly once
    // Fallback re-asks from the CLEAN prompt — no folded tool-result transcript.
    const fallbackMessages = chat.chat.mock.calls[0]![0] as ChatMessage[];
    expect(fallbackMessages.some((m) => m.content.includes('Tool result'))).toBe(false);
  });

  it('no dropped context → plain chat, retrieve tool never offered', async () => {
    // Cold/short conversation (droppedCount 0): the tool would only invite small
    // models to emit empty tool calls or leak tool JSON, so it must not be offered.
    const chatTurn = vi.fn();
    const chat = { chat: vi.fn().mockResolvedValue('direct reply'), chatTurn };

    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi' },
    );

    expect(result).toMatchObject({ kind: 'reply', reply: 'direct reply' });
    expect(chatTurn).not.toHaveBeenCalled();
    expect(chat.chat).toHaveBeenCalledTimes(1);
  });

  it('prior turns are re-projected from the graph as chat messages', async () => {
    // The history query (2nd pool.query) returns earlier turns; they must reach
    // the model as role-tagged messages so it stays coherent across turns.
    const pool = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ version_hash: 't'.repeat(64) }] }) // tip lookup
        .mockResolvedValueOnce({
          // SQL returns newest-first (ORDER BY id DESC); the loader reverses it.
          rows: [
            { kind: 'conversation.assistant', text: 'which city?' },
            { kind: 'conversation.user', text: 'book me a flight' },
          ],
        }),
    } as unknown as Pool;
    const chat = { chat: vi.fn().mockResolvedValue('Auckland it is') };

    await runConversationTurn(
      { pool, wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'Auckland' },
    );

    const sent = chat.chat.mock.calls[0]![0] as ChatMessage[];
    expect(sent[0]!.role).toBe('system'); // conversational role
    expect(sent.slice(1)).toEqual([
      { role: 'user', content: 'book me a flight' },
      { role: 'assistant', content: 'which city?' },
      { role: 'user', content: 'Auckland' },
    ]);
  });

  it('LLM failure returns an error result (turn fails, scope intact)', async () => {
    const chat = { chat: vi.fn().mockRejectedValue(new Error('429 rate limit')) };
    const result = await runConversationTurn(
      { pool: makePool(), wMax: 4096, embed: null, chat },
      { scopeId: 's1', text: 'hi' },
    );
    expect(result).toMatchObject({ kind: 'error' });
    expect(occWrite).not.toHaveBeenCalled();
  });
});

describe('conversationMemoryBlock', () => {
  it('includes lessons, capabilities, and CCR guidance — never raw trail events', () => {
    const block = conversationMemoryBlock({
      ...baseContext,
      reflectionContent: 'LESSON: prefer X',
      capabilityContent: 'CAN: search',
      context: [{ event_type: 'plan_created', payload: '{"a":1}' } as never],
      ccrInstructions: 'USE memex_retrieve',
    });
    expect(block).toContain('LESSON: prefer X');
    expect(block).toContain('CAN: search');
    expect(block).toContain('USE memex_retrieve');
    // The parrotable raw trail listing must NOT appear in the conversation prompt.
    expect(block).not.toContain('[plan_created]');
  });

  it('returns empty string when there is no prose context', () => {
    expect(conversationMemoryBlock(baseContext)).toBe('');
  });

  it('frames memory as internal/non-displayable, not a parrotable "## MEMORY" heading', () => {
    // An 8b model echoed a "## MEMORY" heading back as a "(MEMORY) …" reply
    // prefix (observed live). The block must not reintroduce that heading.
    const block = conversationMemoryBlock({ ...baseContext, reflectionContent: 'L' });
    expect(block).not.toContain('## MEMORY');
    expect(block.toLowerCase()).toContain('private reference');
  });
});

describe('CONVERSATION_SYSTEM_ROLE tripwire (tool axis)', () => {
  // HARD TRIPWIRE — see the comment above CONVERSATION_SYSTEM_ROLE in core.ts.
  // The conversation core has NO external tools today, so the role tells the
  // model it has none. The MOMENT chat gains a real tool (#17 MCP ecosystem),
  // that claim becomes a lie and this test will fail — DO NOT just delete the
  // assertion. Failure is the signal to make the role capability-aware (describe
  // the tools actually bound) instead of a static "you have no tools" string.
  it('claims no external/tool access (must break when chat gains real tools)', () => {
    const role = CONVERSATION_SYSTEM_ROLE.toLowerCase();
    expect(role).toContain('no access to the live internet');
    expect(role).toMatch(/no ability to call apis|run tools/);
  });

  it('forbids fabrication and reply-prefix labels', () => {
    const role = CONVERSATION_SYSTEM_ROLE.toLowerCase();
    expect(role).toContain('never fabricate');
    expect(role).toContain('(memory)'); // the no-label instruction names the leak
  });
});
