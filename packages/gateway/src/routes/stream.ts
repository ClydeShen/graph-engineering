/**
 * GET /v1/stream — SSE push channel for the console realtime surfaces (ADR-44 D-1).
 *
 * ONE shared LISTEN connection fans out graph_event_ready pulses to every SSE
 * subscriber. The previous design took a pool client PER SSE connection and held
 * it for the connection's lifetime; a browser disconnect behind the Next dev
 * proxy never reached the gateway, so those clients were never released and the
 * pool (max 10) exhausted within minutes — after which no stream could connect
 * and realtime silently died for everyone (reads blocked too). With a single
 * shared listener, SSE connections never touch the pool, so exhaustion is
 * impossible regardless of how many tabs/pages subscribe.
 *
 * The pulse-only NOTIFY semantics (ADR 32 D-4) make loss recoverable: when the
 * shared listener drops (DB bounce) it reconnects and emits one synthetic pulse
 * so every still-connected subscriber reconciles via REST.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logger';
import type { TrailSseEvent } from '@graph/types/shell';
import { parseGraphEventReadyPayload } from '@graph/shared';

const log = logger.child({ component: 'gateway', route: 'GET /v1/stream' });

const RECONNECT_DELAY_MS = 1000;

export function buildStreamRoute(pool: Pool): Hono {
  const app = new Hono();

  const subscribers = new Set<(evt: TrailSseEvent) => void>();
  let listenClient: PoolClient | null = null;
  let connecting: Promise<void> | null = null;

  function fanout(evt: TrailSseEvent): void {
    for (const emit of subscribers) emit(evt);
  }

  async function enrich(eventId: string | number): Promise<TrailSseEvent> {
    const base: TrailSseEvent = {
      type: 'trail_event',
      event_type: 'trail_appended',
      payload: { event_id: eventId },
      scope_id: '',
      timestamp: new Date().toISOString(),
    };
    try {
      // N4: payload is JSON {id} (occWrite contract) — already parsed to eventId.
      const { rows } = await pool.query<{ scope_id: string; event_type: string }>(
        'SELECT scope_id, event_type FROM execution_event_log WHERE id = $1',
        [eventId],
      );
      if (rows.length > 0) {
        return { ...base, event_type: rows[0]!.event_type, scope_id: rows[0]!.scope_id };
      }
    } catch {
      /* enrichment is best-effort — the bare pulse still triggers a reconcile */
    }
    return base;
  }

  async function connectListener(): Promise<void> {
    const client = await pool.connect();
    client.on('notification', (msg) => {
      const eventId = parseGraphEventReadyPayload(msg.payload) ?? msg.payload ?? '';
      void enrich(eventId).then(fanout);
    });
    // A dropped LISTEN connection (e.g. the DB bounced) destroys this client so a
    // dead connection is never returned to the pool, then reconnects while anyone
    // is still watching. The synthetic 'resync' pulse makes subscribers REST-
    // reconcile anything missed during the gap (the live pulse is lossy).
    client.on('error', (err) => {
      log.warn({ err }, 'stream.listen_client_dropped');
      if (listenClient === client) listenClient = null;
      try {
        client.release(true);
      } catch {
        /* already removed from the pool */
      }
      if (subscribers.size > 0) {
        setTimeout(() => {
          void ensureListener()
            .then(() =>
              fanout({
                type: 'trail_event',
                event_type: 'resync',
                payload: { event_id: '' },
                scope_id: '',
                timestamp: new Date().toISOString(),
              }),
            )
            .catch((e) => log.error({ err: e }, 'stream.listen_reconnect_failed'));
        }, RECONNECT_DELAY_MS);
      }
    });
    await client.query('LISTEN graph_event_ready');
    listenClient = client;
  }

  function ensureListener(): Promise<void> {
    if (listenClient) return Promise.resolve();
    if (!connecting) {
      connecting = connectListener().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  app.get('/stream', async (c) => {
    try {
      await ensureListener();
    } catch (err) {
      log.error({ err }, 'stream.error');
      return c.json({ error: 'internal server error' }, 500);
    }
    return streamSSE(c, async (stream) => {
      const emit = (evt: TrailSseEvent) => {
        void stream.writeSSE({ event: 'trail_event', data: JSON.stringify(evt) });
      };
      subscribers.add(emit);
      try {
        // Keepalive ping doubles as dead-peer detection: when the client (or the
        // Next proxy) goes away, the AWAITED write rejects → we break and the
        // finally removes the subscriber. Without awaiting, a disconnect behind
        // the proxy would never be noticed and the subscriber would leak.
        while (!stream.closed) {
          await stream.sleep(30000);
          if (stream.closed) break;
          try {
            await stream.writeSSE({ event: 'ping', data: '' });
          } catch {
            break;
          }
        }
      } finally {
        subscribers.delete(emit);
      }
    });
  });

  return app;
}
