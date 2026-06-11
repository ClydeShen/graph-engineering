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

  it('forwards pg_notify notification payload to SSE writeSSE', async () => {
    let capturedNotificationHandler: ((msg: { payload?: string }) => void) | null = null;
    const mockWriteSSE = vi.fn().mockResolvedValue(undefined);

    const mockClient = makeMockClient((event, handler) => {
      if (event === 'notification') {
        capturedNotificationHandler = handler;
      }
    });
    const pool = makePool(mockClient);

    let resolveCallback!: () => void;
    const callbackDone = new Promise<void>((res) => { resolveCallback = res; });

    mockStreamSSE.mockImplementation((_c, callback) => {
      const mockStream = {
        writeSSE: mockWriteSSE,
        sleep: vi.fn().mockResolvedValue(undefined),
        closed: true,
      };
      void callback(mockStream as unknown as Parameters<typeof callback>[0]).then(resolveCallback);
      return new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });

    const app = buildStreamRoute(pool);
    await app.fetch(new Request('http://x/stream'));
    // Wait for the async callback (pool.connect + client.on registration) to complete
    await callbackDone;

    expect(capturedNotificationHandler).not.toBeNull();
    capturedNotificationHandler!({ payload: '{"type":"trail_event"}' });
    expect(mockWriteSSE).toHaveBeenCalledWith({ data: '{"type":"trail_event"}' });
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
