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
import { buildMcpRoute } from './routes/mcp.js';
import { buildAgentsRoute } from './routes/agents.js';
import { buildStreamRoute } from './routes/stream.js';
import { buildSkillsRoute } from './routes/skills.js';
import { OpenAICompatibleProvider } from '@graph/shared';
import { createDdlPool } from '@graph/control-plane/db/ddl-pool';
import { logger } from '@shared/logger';
import { generatePairingCode, verifyPairingCode, markPaired, TTL_SECONDS } from './auth/pairing.js';

const DEFAULT_W_MAX = 4096;

const gatewayLlmProvider = new OpenAICompatibleProvider({
  api: 'openai-completions',
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
export function buildApp(pool: Pool, ddlPool: Pool, wMax: number): Hono {
  const app = new Hono();

  // Mount route modules
  app.route('/v1/scopes', buildScopesRoute(pool, ddlPool, wMax));
  app.route('/v1/scopes', buildEventsRoute(pool, wMax));
  app.route('/v1/scopes', buildScopeReadRoute(pool, wMax));
  app.route('/v1', buildHealthRoute(pool));
  app.route('/v1', buildTopologyRoute(pool));
  app.route('/v1', buildMemoryRoute(pool, gatewayLlmProvider));
  app.route('/v1', buildStreamRoute(pool));
  app.route('/v1', buildSkillsRoute());
  app.route('/', buildMcpRoute(pool));
  app.route('/', buildAgentsRoute(pool));

  // POST /pair/generate — admin-only; gated by GRAPH_RUNTIME_SECRET Bearer token
  app.post('/pair/generate', async (c) => {
    const secret = process.env['GRAPH_RUNTIME_SECRET'];
    if (secret) {
      const auth = c.req.header('Authorization');
      if (auth !== `Bearer ${secret}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    const { agent_id } = (await c.req.json()) as { agent_id: string };
    const { code } = generatePairingCode(agent_id);
    return c.json({ code, expires_in_s: TTL_SECONDS });
  });

  // POST /pair — verify pairing code and mark agent as paired
  app.post('/pair', async (c) => {
    const { agent_id, code } = (await c.req.json()) as { agent_id: string; code: string };
    const result = verifyPairingCode(agent_id, code);
    if (result.ok) {
      markPaired(agent_id);
      return c.json({ paired: true });
    }
    return c.json({ error: result.reason }, 401);
  });

  return app;
}

// Production entry point — env reads consolidated here (ADR 22)
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/graph';
const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const ddlPool = createDdlPool(DATABASE_URL);
const wMax = Number(process.env.CONTEXT_W_MAX ?? DEFAULT_W_MAX);

const app = buildApp(pool, ddlPool, wMax);

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
