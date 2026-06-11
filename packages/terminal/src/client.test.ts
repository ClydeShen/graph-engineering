/**
 * client.test.ts — MemexTerminalClient protocol logic with injected transports.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemexTerminalClient, type WsLike } from './client.js';

type Listener = (evt: { data?: unknown }) => void;

class FakeWs implements WsLike {
  sent: string[] = [];
  listeners = new Map<string, Listener[]>();
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.emit('close', {});
  }
  addEventListener(type: 'open' | 'message' | 'close' | 'error', cb: Listener): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  emit(type: string, evt: { data?: unknown }): void {
    for (const cb of this.listeners.get(type) ?? []) cb(evt);
  }
}

function makeClient(): { client: MemexTerminalClient; ws: FakeWs; fetchFn: ReturnType<typeof vi.fn> } {
  const ws = new FakeWs();
  const fetchFn = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ scope_id: 'scope-t', plan_hash: 'p'.repeat(64) }),
  });
  const client = new MemexTerminalClient({
    gatewayUrl: 'http://localhost:3000',
    token: 'tok',
    wsFactory: () => ws,
    fetchFn: fetchFn as unknown as typeof fetch,
    turnTimeoutMs: 200,
  });
  return { client, ws, fetchFn };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MemexTerminalClient', () => {
  it('createScope POSTs intent with Bearer token and stores the session (zero local state beyond it)', async () => {
    const { client, fetchFn } = makeClient();
    const session = await client.createScope('session:terminal:1');

    expect(fetchFn).toHaveBeenCalledWith(
      'http://localhost:3000/v1/scopes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer tok' }),
      }),
    );
    expect(session.scope_id).toBe('scope-t');
    expect(session.tip_hash).toBe('p'.repeat(64));
  });

  it('connect resolves on open and subscribe sends the protocol message', async () => {
    const { client, ws } = makeClient();
    const connectP = client.connect();
    ws.emit('open', {});
    await connectP;

    client.subscribe('scope-t');
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: 'subscribe', scope_id: 'scope-t' });
  });

  it('sendUserMessage uses the session tip as predecessor and resolves on correlated turn_result', async () => {
    const { client, ws } = makeClient();
    await client.createScope('s');
    const connectP = client.connect();
    ws.emit('open', {});
    await connectP;

    const turnP = client.sendUserMessage('hello graph');
    const sent = JSON.parse(ws.sent[0]!) as {
      type: string;
      request_id: string;
      event: { predecessor_hash: string; event_type: string; payload: { text: string } };
    };
    expect(sent.type).toBe('agent_event');
    expect(sent.event.event_type).toBe('task_spawned');
    expect(sent.event.predecessor_hash).toBe('p'.repeat(64));
    expect(sent.event.payload.text).toBe('hello graph');

    ws.emit('message', {
      data: JSON.stringify({
        type: 'turn_result',
        request_id: sent.request_id,
        version_hash: 'n'.repeat(64),
        occ_result: 'won',
        context: null,
      }),
    });

    const result = await turnP;
    expect(result.occ_result).toBe('won');
    // tip advanced — the NEXT message chains on the new hash (graph-projected state)
    expect(client.session.tip_hash).toBe('n'.repeat(64));
  });

  it('trail events fan out to registered handlers; unsubscribe stops delivery', async () => {
    const { client, ws } = makeClient();
    const connectP = client.connect();
    ws.emit('open', {});
    await connectP;

    const seen: string[] = [];
    const off = client.onTrailEvent((evt) => seen.push(evt.event_type));
    ws.emit('message', {
      data: JSON.stringify({ type: 'trail_event', event_type: 'memory_updated', payload: {}, scope_id: 's', timestamp: 't' }),
    });
    off();
    ws.emit('message', {
      data: JSON.stringify({ type: 'trail_event', event_type: 'scope_closed', payload: {}, scope_id: 's', timestamp: 't' }),
    });

    expect(seen).toEqual(['memory_updated']);
  });

  it('turn times out when no result arrives', async () => {
    const { client, ws } = makeClient();
    await client.createScope('s');
    const connectP = client.connect();
    ws.emit('open', {});
    await connectP;

    await expect(client.sendUserMessage('void')).rejects.toThrow('turn timed out');
  });

  it('error replies resolve the pending turn instead of hanging it', async () => {
    const { client, ws } = makeClient();
    await client.createScope('s');
    const connectP = client.connect();
    ws.emit('open', {});
    await connectP;

    const turnP = client.sendUserMessage('boom');
    const sent = JSON.parse(ws.sent[0]!) as { request_id: string };
    ws.emit('message', {
      data: JSON.stringify({ type: 'error', request_id: sent.request_id, message: 'turn failed' }),
    });
    const result = await turnP;
    expect(result.context).toBeNull();
  });
});
