import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Pool } from 'pg';
import { logger } from '@shared/logger';

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
            void stream.writeSSE({ data: msg.payload ?? '' });
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
