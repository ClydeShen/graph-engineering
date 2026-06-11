/**
 * Realtime endpoint auth + connection rate limiting (ADR-44 D-2/D-3).
 *
 * Token sources (first match wins): Authorization: Bearer <t>, ?token=<t>.
 * Configured token comes from gateway.token in ~/.memex/config.json or
 * MEMEX_GATEWAY_TOKEN env.
 *
 * No-token mode: permitted ONLY while the gateway binds localhost (the
 * default). If MEMEX_BIND exposes the gateway and no token is configured,
 * realtime connections are refused outright — exposing without auth must be
 * a double explicit choice.
 *
 * Rate limit: per-source new-connection budget (default 10/min) with an
 * in-memory bucket — single-process semantics (multi-replica is Phase 15).
 */

import type { Context, Next } from 'hono';
import { timingSafeEqual } from 'crypto';

export const REALTIME_CONNECT_LIMIT_PER_MIN = 10;

const buckets = new Map<string, { count: number; windowStart: number }>();

export function _resetRealtimeBucketsForTest(): void {
  buckets.clear();
}

function sourceKey(c: Context): string {
  return c.req.header('x-forwarded-for') ?? 'local';
}

function tokenMatches(provided: string, configured: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function realtimeAuth(getConfiguredToken: () => string | undefined) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    // Connection rate limit (D-3)
    const key = sourceKey(c);
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.windowStart > 60_000) {
      buckets.set(key, { count: 1, windowStart: now });
    } else {
      bucket.count++;
      if (bucket.count > REALTIME_CONNECT_LIMIT_PER_MIN) {
        return c.json({ error: 'rate_limited' }, 429);
      }
    }

    const configured = getConfiguredToken();
    const provided =
      c.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ??
      c.req.query('token') ??
      undefined;

    if (configured === undefined || configured === '') {
      // No token configured: only acceptable while bound to localhost.
      const bind = process.env['MEMEX_BIND'] ?? '127.0.0.1';
      if (bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1') {
        return c.json({ error: 'realtime requires gateway.token when exposed' }, 401);
      }
      return next();
    }

    if (provided === undefined || !tokenMatches(provided, configured)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    return next();
  };
}
