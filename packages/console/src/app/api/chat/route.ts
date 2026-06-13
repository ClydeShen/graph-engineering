/**
 * POST /api/chat — server-side bridge from the Console to the Gateway
 * conversation core (ADR 54).
 *
 * The Gateway's realtime endpoints are token-gated (gateway.token in
 * ~/.memex/config.json). The token must never reach the browser, so this
 * Next.js route handler holds it server-side: it opens a WS to the Gateway,
 * submits one user_message turn, and re-emits the text_delta stream to the
 * browser as SSE frames:
 *
 *   data: {"type":"delta","text":"..."}        (accumulating reply text)
 *   data: {"type":"done","reply":"...", ...}   (turn_result)
 *   data: {"type":"error","message":"..."}
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const runtime = 'nodejs';

const TURN_TIMEOUT_MS = 300_000; // local models can be slow — generous cap

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

function wsUrl(): string {
  const base = gatewayHttpUrl().replace(/\/$/, '').replace(/^http/, 'ws') + '/ws';
  const token = gatewayToken();
  return token !== undefined ? `${base}?token=${encodeURIComponent(token)}` : base;
}

interface WsServerFrame {
  type: string;
  request_id?: string;
  event_type?: string;
  payload?: { text?: string; request_id?: string };
  reply?: string;
  version_hash?: string;
  suspended?: boolean;
  message?: string;
}

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { scope_id?: string; text?: string };
  const { scope_id, text } = body;
  if (typeof scope_id !== 'string' || typeof text !== 'string' || text.length === 0) {
    return Response.json({ error: 'scope_id and text are required' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const requestId = `console-${crypto.randomUUID().slice(0, 8)}`;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let ws: WebSocket;
      let closed = false;

      const emit = (frame: Record<string, unknown>): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        controller.close();
      };
      const fail = (message: string): void => {
        emit({ type: 'error', message });
        finish();
      };

      const timer = setTimeout(() => fail('turn timed out'), TURN_TIMEOUT_MS);

      try {
        ws = new WebSocket(wsUrl());
      } catch (err) {
        fail(`cannot reach gateway: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'user_message', scope_id, request_id: requestId, text }));
      });
      ws.addEventListener('message', (evt) => {
        let frame: WsServerFrame;
        try {
          frame = JSON.parse(String(evt.data)) as WsServerFrame;
        } catch {
          return;
        }
        if (frame.type === 'trail_event' && frame.event_type === 'text_delta') {
          if (frame.payload?.request_id === requestId && typeof frame.payload.text === 'string') {
            emit({ type: 'delta', text: frame.payload.text });
          }
          return;
        }
        if (frame.type === 'turn_result' && frame.request_id === requestId) {
          if (frame.suspended === true) {
            emit({ type: 'error', message: 'scope is suspended — reconcile it before chatting' });
          } else {
            emit({ type: 'done', reply: frame.reply ?? '', version_hash: frame.version_hash });
          }
          finish();
          return;
        }
        if (frame.type === 'error' && (frame.request_id === undefined || frame.request_id === requestId)) {
          fail(frame.message ?? 'gateway error');
        }
      });
      ws.addEventListener('error', () => fail('gateway websocket error — is the stack running?'));
      ws.addEventListener('close', () => {
        if (!closed) fail('gateway closed the connection mid-turn');
      });

      req.signal.addEventListener('abort', finish);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
