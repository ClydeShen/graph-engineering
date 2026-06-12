/**
 * GET /ws — bidirectional realtime endpoint for MemexTerminal (ADR-44 D-1).
 *
 * Protocol (@graph/types/shell):
 *   client → { type: 'agent_event', scope_id, event, request_id? }
 *             → runs the SAME processAgentTurn as POST /v1/scopes/:id/events
 *             → { type: 'turn_result', request_id, ... }
 *   client → { type: 'subscribe', scope_id? }   (omitted scope_id = all scopes)
 *   server → { type: 'trail_event', ... }        broadcast from pg LISTEN
 *
 * The WS transport is a mirror of the REST event protocol — zero new write
 * semantics. text_delta is reserved (enum slot) until gateway-side LLM
 * streaming lands.
 *
 * Message handling is extracted into handleWsMessage() so the protocol logic
 * is unit-testable without a Bun socket.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { EventBodySchema } from '@shared/schemas';
import { logger } from '@shared/logger';
import type { EmbeddingProvider } from '@graph/shared';
import type {
  WsClientMessage,
  WsServerMessage,
  TrailSseEvent,
} from '@graph/types/shell';
import { processAgentTurn } from '../process-agent-turn.js';

const log = logger.child({ component: 'gateway', route: 'GET /ws' });

export const WS_MESSAGE_LIMIT_PER_SEC = 20;

export interface WsConnectionState {
  /** Subscribed scope ids; '*' subscribes to all. */
  subscriptions: Set<string>;
  /** Sliding message-rate window (D-3). */
  windowStart: number;
  messageCount: number;
}

export function newConnectionState(): WsConnectionState {
  return { subscriptions: new Set(), windowStart: Date.now(), messageCount: 0 };
}

/** Returns false when the connection exceeded the per-second message budget. */
export function admitMessage(state: WsConnectionState, now = Date.now()): boolean {
  if (now - state.windowStart > 1000) {
    state.windowStart = now;
    state.messageCount = 0;
  }
  state.messageCount++;
  return state.messageCount <= WS_MESSAGE_LIMIT_PER_SEC;
}

/**
 * Handle one client message. Returns the server response message, or null when
 * the message produces no direct reply (subscribe).
 */
export async function handleWsMessage(
  deps: { pool: Pool; wMax: number; embed: EmbeddingProvider | null },
  raw: string,
  state: WsConnectionState,
): Promise<WsServerMessage | null> {
  let msg: WsClientMessage;
  try {
    msg = JSON.parse(raw) as WsClientMessage;
  } catch {
    return { type: 'error', message: 'invalid JSON' };
  }

  if (msg.type === 'subscribe') {
    state.subscriptions.add(msg.scope_id ?? '*');
    return null;
  }

  if (msg.type === 'agent_event') {
    const parsed = EventBodySchema.safeParse(msg.event);
    if (!parsed.success) {
      return { type: 'error', request_id: msg.request_id, message: 'invalid event body' };
    }
    if (typeof msg.scope_id !== 'string' || msg.scope_id.length === 0) {
      return { type: 'error', request_id: msg.request_id, message: 'missing scope_id' };
    }
    try {
      const outcome = await processAgentTurn(deps.pool, msg.scope_id, parsed.data, deps.wMax, deps.embed);
      if (outcome.suspended) {
        return { type: 'turn_result', request_id: msg.request_id, suspended: true, context: null };
      }
      if ('deduplicated' in outcome && outcome.deduplicated) {
        return { type: 'turn_result', request_id: msg.request_id, deduplicated: true, context: null };
      }
      return {
        type: 'turn_result',
        request_id: msg.request_id,
        version_hash: outcome.version_hash,
        occ_result: outcome.occ_result,
        context: outcome.context,
      };
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'ws.turn.error');
      return { type: 'error', request_id: msg.request_id, message: 'turn failed' };
    }
  }

  return { type: 'error', message: 'unknown message type' };
}

// ── Broadcast: pg LISTEN → subscribed WS clients ────────────────────────────

interface BroadcastClient {
  send(data: string): void;
  state: WsConnectionState;
}

export class WsBroadcaster {
  private clients = new Set<BroadcastClient>();
  private started = false;

  attach(client: BroadcastClient): void {
    this.clients.add(client);
  }

  detach(client: BroadcastClient): void {
    this.clients.delete(client);
  }

  /** Deliver a trail event to every client subscribed to its scope (or '*'). */
  deliver(event: TrailSseEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.state.subscriptions.has('*') || client.state.subscriptions.has(event.scope_id)) {
        try {
          client.send(data);
        } catch {
          this.clients.delete(client); // slow/dead consumer: drop, do not queue (D-3)
        }
      }
    }
  }

  /** Start the LISTEN loop once. Point-queries each pulse for scope/event_type. */
  async start(pool: Pool): Promise<void> {
    if (this.started) return;
    this.started = true;
    const client = await pool.connect();
    await client.query('LISTEN graph_event_ready');
    client.on('notification', (msg) => {
      void (async () => {
        try {
          const eventId = msg.payload ?? '';
          const { rows } = await pool.query<{ scope_id: string; event_type: string }>(
            'SELECT scope_id, event_type FROM execution_event_log WHERE id = $1',
            [eventId],
          );
          if (rows.length === 0) return;
          this.deliver({
            type: 'trail_event',
            event_type: rows[0]!.event_type,
            payload: { event_id: eventId },
            scope_id: rows[0]!.scope_id,
            timestamp: new Date().toISOString(),
          });
        } catch {
          /* broadcast is best-effort */
        }
      })();
    });
  }
}

// ── Route assembly ────────────────────────────────────────────────────────────

/** Minimal socket surface shared by Bun ('hono/bun') and Node ('@hono/node-ws'). */
export interface WsLikeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * Per-connection lifecycle handlers — runtime-agnostic core shared by the Bun
 * and Node upgrade adapters (TD-M, ADR-48). Both runtimes' upgradeWebSocket
 * call this factory once per connection.
 */
export function makeWsConnectionHandlers(
  deps: { pool: Pool; wMax: number; embed: EmbeddingProvider | null },
  broadcaster: WsBroadcaster,
): () => {
  onOpen(evt: unknown, ws: WsLikeSocket): void;
  onMessage(evt: { data?: unknown }, ws: WsLikeSocket): Promise<void>;
  onClose(): void;
} {
  return () => {
    const state = newConnectionState();
    let attached: BroadcastClient | null = null;
    return {
      onOpen(_evt: unknown, ws: WsLikeSocket) {
        attached = { send: (d: string) => ws.send(d), state };
        broadcaster.attach(attached);
        void broadcaster.start(deps.pool).catch(() => {
          /* LISTEN unavailable (e.g. mock pool) — request/response path still works */
        });
      },
      async onMessage(evt: { data?: unknown }, ws: WsLikeSocket) {
        if (!admitMessage(state)) {
          ws.close(1008, 'message rate exceeded');
          return;
        }
        const reply = await handleWsMessage(deps, String(evt.data), state);
        if (reply !== null) ws.send(JSON.stringify(reply));
      },
      onClose() {
        if (attached) broadcaster.detach(attached);
      },
    };
  };
}

/**
 * Build the /ws route for the Bun runtime. Async because 'hono/bun' references
 * the Bun global at import time — the dynamic import keeps this module loadable
 * under Node (vitest) where only the protocol logic above is exercised.
 */
export async function buildWsRoute(
  pool: Pool,
  wMax: number,
  embed: EmbeddingProvider | null,
): Promise<{ app: Hono; websocket: unknown; broadcaster: WsBroadcaster }> {
  const { createBunWebSocket } = await import('hono/bun');
  const { upgradeWebSocket, websocket } = createBunWebSocket();
  const app = new Hono();
  const broadcaster = new WsBroadcaster();
  // `as never`: Bun's handler generics are narrower than the shared shape; the
  // runtime contract (onOpen/onMessage/onClose) is identical.
  app.get('/ws', upgradeWebSocket(makeWsConnectionHandlers({ pool, wMax, embed }, broadcaster) as never));
  return { app, websocket, broadcaster };
}

/**
 * Mount /ws on the MAIN app for the Node runtime (TD-M, ADR-48 — Node 22 is the
 * primary supported runtime). '@hono/node-ws' requires the same Hono instance
 * that serve() runs, because injectWebSocket(server) routes the HTTP upgrade
 * back through that app's matched route — a sub-app mounted via app.route()
 * would not receive the upgrade.
 */
export async function buildWsRouteNode(
  app: Hono,
  pool: Pool,
  wMax: number,
  embed: EmbeddingProvider | null,
): Promise<{ injectWebSocket: (server: unknown) => void; broadcaster: WsBroadcaster }> {
  const { createNodeWebSocket } = await import('@hono/node-ws');
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
  const broadcaster = new WsBroadcaster();
  app.get('/ws', upgradeWebSocket(makeWsConnectionHandlers({ pool, wMax, embed }, broadcaster) as never));
  return { injectWebSocket: injectWebSocket as (server: unknown) => void, broadcaster };
}
