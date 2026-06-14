import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, PoolClient } from 'pg';

// Mock hono/streaming before importing the module under test
vi.mock('hono/streaming', () => {
  return {
    streamSSE: vi.fn(),
  };
});

import { streamSSE } from 'hono/streaming';
import { buildStreamRoute } from './stream.js';

const mockStreamSSE = vi.mocked(streamSSE);

function makeMockClient(
  onFn?: (event: string, handler: (msg: { payload?: string }) => void) => void,
): PoolClient {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    on: onFn ?? vi.fn(),
    release: vi.fn(),
  } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

function makeFailingPool(): Pool {
  return {
    connect: vi.fn().mockRejectedValue(new Error('conn failed')),
  } as unknown as Pool;
}

describe('GET /v1/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls streamSSE and sets SSE response (Content-Type text/event-stream)', async () => {
    const mockClient = makeMockClient();
    const pool = makePool(mockClient);

    // streamSSE mock: immediately invoke callback with a closed stream
    mockStreamSSE.mockImplementation((_c, callback) => {
      const mockStream = {
        writeSSE: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined),
        closed: true,
      };
      void callback(mockStream as unknown as Parameters<typeof callback>[0]);
      return new Response(null, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const app = buildStreamRoute(pool);
    const res = await app.fetch(new Request('http://x/stream'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    expect(mockStreamSSE).toHaveBeenCalledOnce();
  });

  it('forwards pg_notify pulses as structured TrailSseEvent (point-query enriched)', async () => {
    let capturedNotificationHandler: ((msg: { payload?: string }) => void) | null = null;
    const mockWriteSSE = vi.fn().mockResolvedValue(undefined);

    const mockClient = makeMockClient((event, handler) => {
      if (event === 'notification') {
        capturedNotificationHandler = handler;
      }
    });
    // Pool-level query is the point-query enrichment path (ADR-44 D-1).
    const pool = {
      connect: vi.fn().mockResolvedValue(mockClient),
      query: vi.fn().mockResolvedValue({
        rows: [{ scope_id: 'scope-9', event_type: 'memory_updated' }],
      }),
    } as unknown as Pool;

    // Keep the SSE callback alive so the subscriber stays registered when the
    // pulse fires: the subscriber is added synchronously before the first await,
    // and the keepalive sleep never resolves (so no ping is written either).
    mockStreamSSE.mockImplementation((_c, callback) => {
      const mockStream = {
        writeSSE: mockWriteSSE,
        sleep: vi.fn().mockReturnValue(new Promise<void>(() => {})),
        closed: false,
      };
      void callback(mockStream as unknown as Parameters<typeof callback>[0]);
      return new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const app = buildStreamRoute(pool);
    // ensureListener() registers the shared notification handler before streamSSE.
    await app.fetch(new Request('http://x/stream'));

    expect(capturedNotificationHandler).not.toBeNull();
    capturedNotificationHandler!({ payload: 'event-id-42' });
    // The notification handler point-queries asynchronously — flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    expect(mockWriteSSE).toHaveBeenCalledWith({
      event: 'trail_event',
      data: expect.stringContaining('"scope_id":"scope-9"'),
    });
    const sent = JSON.parse(
      (mockWriteSSE.mock.calls[0]![0] as { data: string }).data,
    ) as { type: string; event_type: string; payload: { event_id: string } };
    expect(sent.type).toBe('trail_event');
    expect(sent.event_type).toBe('memory_updated');
    expect(sent.payload.event_id).toBe('event-id-42');
  });

  it('returns 500 when pool.connect() throws (pre-SSE error path)', async () => {
    // pool.connect() rejects inside the streamSSE callback.
    // Simulate this by having streamSSE throw synchronously when the callback fails.
    const pool = makeFailingPool();

    mockStreamSSE.mockImplementation((_c, callback) => {
      const mockStream = {
        writeSSE: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined),
        closed: true,
      };
      // Simulate the streaming library re-throwing callback errors at the boundary
      throw new Error('conn failed');
    });

    const app = buildStreamRoute(pool);
    const res = await app.fetch(new Request('http://x/stream'));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('internal server error');
  });
});
