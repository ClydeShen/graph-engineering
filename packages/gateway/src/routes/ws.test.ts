/**
 * ws.test.ts — WS protocol handler + broadcaster + message rate limit (ADR-44).
 * Socket-free: handleWsMessage and WsBroadcaster are tested directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const processAgentTurn = vi.fn();
vi.mock('../process-agent-turn.js', () => ({
  processAgentTurn: (...a: unknown[]) => processAgentTurn(...a),
}));
vi.mock('@shared/logger', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

import {
  handleWsMessage,
  newConnectionState,
  admitMessage,
  WsBroadcaster,
  WS_MESSAGE_LIMIT_PER_SEC,
  makeWsConnectionHandlers,
} from './ws-protocol.js';

const pool = {} as Pool;
const embed = { embed: vi.fn() };
const deps = { pool, wMax: 4000, embed, chat: null };

const validEvent = {
  entity_id: '11111111-1111-4111-8111-111111111111',
  event_type: 'memory_updated',
  predecessor_hash: '0'.repeat(64),
  payload: { description: 'x' },
};

beforeEach(() => {
  vi.clearAllMocks();
  processAgentTurn.mockResolvedValue({
    suspended: false,
    version_hash: 'vh',
    occ_result: 'won',
    context: { stable: 's' },
  });
});

describe('handleWsMessage', () => {
  it('invalid JSON yields an error message', async () => {
    const reply = await handleWsMessage(deps, 'not-json{', newConnectionState());
    expect(reply).toEqual({ type: 'error', message: 'invalid JSON' });
  });

  it('subscribe registers the scope and returns no reply', async () => {
    const state = newConnectionState();
    const reply = await handleWsMessage(deps, JSON.stringify({ type: 'subscribe', scope_id: 's1' }), state);
    expect(reply).toBeNull();
    expect(state.subscriptions.has('s1')).toBe(true);
  });

  it('subscribe without scope_id registers the wildcard', async () => {
    const state = newConnectionState();
    await handleWsMessage(deps, JSON.stringify({ type: 'subscribe' }), state);
    expect(state.subscriptions.has('*')).toBe(true);
  });

  it('agent_event runs processAgentTurn and returns turn_result with request_id', async () => {
    const reply = await handleWsMessage(
      deps,
      JSON.stringify({ type: 'agent_event', scope_id: 'scope-1', event: validEvent, request_id: 'r1' }),
      newConnectionState(),
    );
    expect(processAgentTurn).toHaveBeenCalledWith(pool, 'scope-1', expect.anything(), 4000, embed);
    expect(reply).toMatchObject({ type: 'turn_result', request_id: 'r1', version_hash: 'vh', occ_result: 'won' });
  });

  it('invalid event body is rejected without touching processAgentTurn', async () => {
    const reply = await handleWsMessage(
      deps,
      JSON.stringify({ type: 'agent_event', scope_id: 's', event: { nope: true }, request_id: 'r2' }),
      newConnectionState(),
    );
    expect(processAgentTurn).not.toHaveBeenCalled();
    expect(reply).toMatchObject({ type: 'error', request_id: 'r2' });
  });

  it('deduplicated outcome surfaces in turn_result', async () => {
    processAgentTurn.mockResolvedValue({ suspended: false, deduplicated: true });
    const reply = await handleWsMessage(
      deps,
      JSON.stringify({ type: 'agent_event', scope_id: 's', event: validEvent }),
      newConnectionState(),
    );
    expect(reply).toMatchObject({ type: 'turn_result', deduplicated: true });
  });
});

describe('admitMessage rate limit', () => {
  it('blocks after WS_MESSAGE_LIMIT_PER_SEC messages within one second', () => {
    const state = newConnectionState();
    const now = Date.now();
    for (let i = 0; i < WS_MESSAGE_LIMIT_PER_SEC; i++) {
      expect(admitMessage(state, now)).toBe(true);
    }
    expect(admitMessage(state, now)).toBe(false);
    // window rollover resets the budget
    expect(admitMessage(state, now + 1100)).toBe(true);
  });
});

describe('WsBroadcaster', () => {
  it('delivers only to clients subscribed to the scope or wildcard', () => {
    const b = new WsBroadcaster();
    const sent: Record<string, string[]> = { a: [], b: [], c: [] };
    const mk = (name: string, scope: string) => {
      const state = newConnectionState();
      state.subscriptions.add(scope);
      return { send: (d: string) => sent[name]!.push(d), state };
    };
    b.attach(mk('a', 'scope-1'));
    b.attach(mk('b', '*'));
    b.attach(mk('c', 'scope-other'));

    b.deliver({ type: 'trail_event', event_type: 'memory_updated', payload: {}, scope_id: 'scope-1', timestamp: 't' });

    expect(sent['a']).toHaveLength(1);
    expect(sent['b']).toHaveLength(1);
    expect(sent['c']).toHaveLength(0);
  });

  it('drops a client whose send throws (slow consumer policy)', () => {
    const b = new WsBroadcaster();
    const state = newConnectionState();
    state.subscriptions.add('*');
    const bad = { send: () => { throw new Error('full'); }, state };
    b.attach(bad);
    const evt = { type: 'trail_event' as const, event_type: 'x', payload: {}, scope_id: 's', timestamp: 't' };
    b.deliver(evt); // throws internally → dropped
    expect(() => b.deliver(evt)).not.toThrow();
  });
});

// ── makeWsConnectionHandlers — runtime-agnostic lifecycle (TD-M, ADR-48) ──────

describe('makeWsConnectionHandlers', () => {
  function fakeSocket() {
    const sent: string[] = [];
    let closed: { code?: number; reason?: string } | null = null;
    return {
      sent,
      get closed() { return closed; },
      send: (d: string) => { sent.push(d); },
      close: (code?: number, reason?: string) => { closed = { code, reason }; },
    };
  }

  it('open → subscribe → broadcast → close detaches (full lifecycle, G1)', async () => {
    const broadcaster = new WsBroadcaster();
    const handlers = makeWsConnectionHandlers(deps, broadcaster)();
    const ws = fakeSocket();

    handlers.onOpen(undefined, ws);
    await handlers.onMessage({ data: JSON.stringify({ type: 'subscribe' }) }, ws);
    broadcaster.deliver({ type: 'trail_event', event_type: 'memory_updated', payload: {}, scope_id: 'any', timestamp: 't' });
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'trail_event', scope_id: 'any' });

    handlers.onClose();
    broadcaster.deliver({ type: 'trail_event', event_type: 'memory_updated', payload: {}, scope_id: 'any', timestamp: 't' });
    expect(ws.sent).toHaveLength(1); // detached — no further delivery
  });

  it('closes the socket with 1008 when the message rate budget is exceeded', async () => {
    const handlers = makeWsConnectionHandlers(deps, new WsBroadcaster())();
    const ws = fakeSocket();
    handlers.onOpen(undefined, ws);
    for (let i = 0; i < WS_MESSAGE_LIMIT_PER_SEC; i++) {
      await handlers.onMessage({ data: '{"type":"subscribe"}' }, ws);
    }
    expect(ws.closed).toBeNull();
    await handlers.onMessage({ data: '{"type":"subscribe"}' }, ws);
    expect(ws.closed).toMatchObject({ code: 1008 });
  });

  it('replies with protocol errors through the same socket (invalid JSON)', async () => {
    const handlers = makeWsConnectionHandlers(deps, new WsBroadcaster())();
    const ws = fakeSocket();
    handlers.onOpen(undefined, ws);
    await handlers.onMessage({ data: 'not-json' }, ws);
    expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: 'error', message: 'invalid JSON' });
  });
});
