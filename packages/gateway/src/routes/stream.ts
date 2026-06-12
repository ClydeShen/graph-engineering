/**
 * GET /v1/stream — SSE push channel for Dashboard (ADR-44 D-1).
 *
 * Each pg_notify pulse (graph_event_ready, payload = event id) is point-queried
 * for scope_id/event_type and forwarded as a structured TrailSseEvent. The
 * pulse-only NOTIFY semantics (ADR 32 D-4) make loss recoverable: clients that
 * reconnect simply point-query for anything missed.
 *
 * Auth + rate limiting are applied at mount time (realtimeAuth middleware).
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Pool } from 'pg';
import { logger } from '@shared/logger';
import type { TrailSseEvent } from '@graph/types/shell';
import { parseGraphEventReadyPayload } from '@graph/shared';

const log = logger.child({ component: 'gateway', route: 'GET /v1/stream' });

export function buildStreamRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/stream', (c) => {
    try {
      return streamSSE(c, async (stream) => {
        const client = await pool.connect();
        try {
          await client.query('LISTEN graph_event_ready');
          client.on('notification', (msg) => {
            void (async () => {
              // N4 fix: payload is JSON {id} (occWrite contract) — parse before lookup.
              const eventId = parseGraphEventReadyPayload(msg.payload) ?? msg.payload ?? '';
              let event: TrailSseEvent = {
                type: 'trail_event',
                event_type: 'trail_appended',
                payload: { event_id: eventId },
                scope_id: '',
                timestamp: new Date().toISOString(),
              };
              try {
                const { rows } = await pool.query<{ scope_id: string; event_type: string }>(
                  'SELECT scope_id, event_type FROM execution_event_log WHERE id = $1',
                  [eventId],
                );
                if (rows.length > 0) {
                  event = { ...event, event_type: rows[0]!.event_type, scope_id: rows[0]!.scope_id };
                }
              } catch {
                /* enrichment is best-effort — the pulse alone is still useful */
              }
              void stream.writeSSE({ event: 'trail_event', data: JSON.stringify(event) });
            })();
          });
          while (!stream.closed) {
            await stream.sleep(30000);
            void stream.writeSSE({ event: 'ping', data: '' });
          }
        } finally {
          client.release();
        }
      });
    } catch (err) {
      log.error({ err }, 'stream.error');
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  return app;
}
