/**
 * HTTP Gateway — Hono app entry point.
 *
 * Mounts the three REST endpoints:
 *   POST /v1/scopes            — create a new Scope (delegates DDL to Control Plane)
 *   POST /v1/scopes/:id/events — submit an event (OCC + inline Watchdog + context)
 *   GET  /v1/scopes/:id        — read scope state + context
 *
 * The pool injected here is SELECT/INSERT only — the Gateway holds NO DDL rights.
 * DDL (partition creation, index creation) is exclusively owned by the Control Plane
 * Daemon via its separate DDL-exclusive pool (ADR 05, ADR 24).
 *
 * @see ADR 24 — HTTP Gateway spec
 * @see REQ-15 — Three REST endpoints
 * @see REQ-16 — Zod validation 400 before DB
 */

import { Hono } from 'hono';
import { Pool } from 'pg';
import { buildScopesRoute } from './routes/scopes.js';
import { buildEventsRoute } from './routes/events.js';
import { buildScopeReadRoute } from './routes/scope-read.js';
import { buildHealthRoute } from './routes/health.js';
import { buildTopologyRoute } from './routes/topology.js';
import { buildMemoryRoute } from './routes/memory.js';
import { OpenAICompatibleProvider } from '@graph/shared';
import { logger } from '@shared/logger';

const gatewayLlmProvider = new OpenAICompatibleProvider({
  baseUrl: process.env['LLM_BASE_URL'] ?? 'http://localhost:11434',
  model: process.env['LLM_MODEL'] ?? 'llama3',
  apiKey: process.env['LLM_API_KEY'] ?? '',
});

/**
 * Build and return the Hono app with all routes mounted.
 *
 * @param pool  Injected SELECT/INSERT pool. In tests, a mock pool can be passed.
 *              In production, this is a real pg.Pool bound to the gateway DB user
 *              (SELECT + INSERT rights only — no DDL per ADR 24).
 */
export function buildApp(pool: Pool): Hono {
  const app = new Hono();

  // Mount route modules
  app.route('/v1/scopes', buildScopesRoute(pool));
  app.route('/v1/scopes', buildEventsRoute(pool));
  app.route('/v1/scopes', buildScopeReadRoute(pool));
  app.route('/v1', buildHealthRoute(pool));
  app.route('/v1', buildTopologyRoute(pool));
  app.route('/v1', buildMemoryRoute(pool, gatewayLlmProvider));

  return app;
}

// Production entry point — export Bun/Node-compatible server object
// Pool uses environment variables for configuration.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

const app = buildApp(pool);

const gatewayPort = Number(process.env.PORT ?? 3000);

logger.child({ component: 'gateway' }).info(
  { port: gatewayPort, url: `http://localhost:${gatewayPort}` },
  'gateway.ready',
);

export default {
  port: gatewayPort,
  fetch: app.fetch,
};

export { app };
