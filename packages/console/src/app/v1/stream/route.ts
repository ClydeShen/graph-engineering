/**
 * GET /v1/stream — SSE proxy from the browser to the Gateway realtime pulse.
 *
 * The next.config rewrite cannot serve this:
 *   1. Next dev BUFFERS proxied (rewrite) responses, so the browser EventSource
 *      connects (readyState OPEN) but never receives the streamed data frames —
 *      curl through the same rewrite works, the browser does not. This is why the
 *      Now universe only updated on a manual refresh.
 *   2. The Gateway realtime endpoints are token-gated and an EventSource cannot
 *      send an Authorization header.
 *
 * This Node route handler holds the gateway token server-side (same as
 * /api/chat) and pipes the upstream ReadableStream straight through, so SSE
 * actually streams to the browser. A filesystem route takes precedence over the
 * afterFiles rewrite, so only /v1/stream is intercepted; every other /v1/* path
 * keeps using the rewrite. req.signal forwards the browser disconnect to the
 * gateway so its shared LISTEN subscriber is cleaned up promptly.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function gatewayHttpUrl(): string {
  return process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://127.0.0.1:4000';
}

function gatewayToken(): string | undefined {
  const env = process.env.MEMEX_GATEWAY_TOKEN;
  if (env !== undefined && env !== '') return env;
  const profile = process.env.MEMEX_PROFILE;
  const configPath =
    profile !== undefined && /^[A-Za-z0-9_-]+$/.test(profile)
      ? join(homedir(), '.memex', 'profiles', profile, 'config.json')
      : join(homedir(), '.memex', 'config.json');
  if (!existsSync(configPath)) return undefined;
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      gateway?: { token?: string };
    };
    return cfg.gateway?.token;
  } catch {
    return undefined;
  }
}

export async function GET(req: Request): Promise<Response> {
  const token = gatewayToken();
  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayHttpUrl()}/v1/stream`, {
      headers: {
        Accept: 'text/event-stream',
        ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      },
      // Forward the browser disconnect upstream so the gateway drops the subscriber.
      signal: req.signal,
    });
  } catch {
    return new Response('upstream stream unavailable', { status: 502 });
  }
  if (!upstream.ok || upstream.body === null) {
    return new Response('upstream stream unavailable', { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tell any intermediary proxy (nginx etc.) not to buffer the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
