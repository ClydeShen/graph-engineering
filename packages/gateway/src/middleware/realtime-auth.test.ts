/**
 * realtime-auth.test.ts — token gate + connection rate limit (ADR-44 D-2/D-3).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import {
  realtimeAuth,
  REALTIME_CONNECT_LIMIT_PER_MIN,
  _resetRealtimeBucketsForTest,
} from './realtime-auth.js';

function appWithAuth(token: string | undefined): Hono {
  const app = new Hono();
  app.use('/rt', realtimeAuth(() => token));
  app.get('/rt', (c) => c.json({ ok: true }));
  return app;
}

beforeEach(() => {
  _resetRealtimeBucketsForTest();
  delete process.env['MEMEX_BIND'];
});

afterEach(() => {
  delete process.env['MEMEX_BIND'];
});

describe('realtimeAuth', () => {
  it('no token configured + localhost bind (default): allows', async () => {
    const res = await appWithAuth(undefined).request('/rt');
    expect(res.status).toBe(200);
  });

  it('no token configured + exposed bind: refuses with 401', async () => {
    process.env['MEMEX_BIND'] = '0.0.0.0';
    const res = await appWithAuth(undefined).request('/rt');
    expect(res.status).toBe(401);
  });

  it('Bearer token accepted', async () => {
    const res = await appWithAuth('sekret').request('/rt', {
      headers: { Authorization: 'Bearer sekret' },
    });
    expect(res.status).toBe(200);
  });

  it('?token= query accepted (WS browser clients cannot set headers)', async () => {
    const res = await appWithAuth('sekret').request('/rt?token=sekret');
    expect(res.status).toBe(200);
  });

  it('wrong token rejected with 401', async () => {
    const res = await appWithAuth('sekret').request('/rt', {
      headers: { Authorization: 'Bearer wrong!' },
    });
    expect(res.status).toBe(401);
  });

  it('missing token (when configured) rejected with 401', async () => {
    const res = await appWithAuth('sekret').request('/rt');
    expect(res.status).toBe(401);
  });

  it('connection rate limit: 429 after the per-minute budget', async () => {
    const app = appWithAuth(undefined);
    for (let i = 0; i < REALTIME_CONNECT_LIMIT_PER_MIN; i++) {
      const res = await app.request('/rt');
      expect(res.status).toBe(200);
    }
    const blocked = await app.request('/rt');
    expect(blocked.status).toBe(429);
  });
});
