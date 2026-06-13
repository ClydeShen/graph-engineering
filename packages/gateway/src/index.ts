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
import { buildForestRoute } from './routes/forest.js';
import { buildEmergenceRoute } from './routes/emergence.js';
import { buildHealthRoute } from './routes/health.js';
import { buildTopologyRoute } from './routes/topology.js';
import { buildMemoryRoute } from './routes/memory.js';
import { buildMcpRoute } from './routes/mcp.js';
import { buildAgentsRoute } from './routes/agents.js';
import { buildStreamRoute } from './routes/stream.js';
import { buildSkillsRoute } from './routes/skills.js';
import { buildArtifactsRoute } from './routes/artifacts.js';
import { buildMetricsRoute } from './routes/metrics.js';
import { buildDecisionsRoute } from './routes/decisions.js';
import { buildWsRoute, buildWsRouteNode } from './routes/ws-protocol.js';
import { buildDashboardRoute } from './routes/dashboard.js';
import { realtimeAuth, tokenAuth } from './middleware/realtime-auth.js';
import {
  loadMemexConfig,
  buildEmbeddingProvider,
  buildChatProvider,
  readLlmOverrides,
  mergeLlmOverrides,
  DEFAULT_GATEWAY_PORT,
  type LLMProvider,
} from '@graph/shared';
import { buildChatRoute } from './routes/chat.js';
import { buildSysConfigRoute } from './routes/sys.js';
import { createDdlPool } from '@graph/control-plane/db/ddl-pool';
import { logger } from '@shared/logger';
import {
  generatePairingCode,
  verifyPairingCode,
  markPaired,
  configurePairingPersistence,
  warmPairingCache,
  TTL_SECONDS,
} from './auth/pairing.js';

const DEFAULT_W_MAX = 4096;

// TD-H (Phase 11): the gateway's provider is only ever consumed as an
// EmbeddingProvider (memReflect in the events route + memory route) — there is
// NO infra chat path here (the ADR-54 conversation core has its own chat
// provider). ADR 55/56: nullable, config-driven — null means the semantic
// index runs degraded (lexical retrieval); the conversation never blocks.
// Appendix A: merge the standalone llm-overrides.json (when present) over the
// config before building providers. Identity when no overrides file exists, so
// every install without one is unchanged. Read once at construction — workers
// pick up edits on next restart (Appendix A: no hot-reload infra).
const resolvedConfig = () => mergeLlmOverrides(loadMemexConfig(), readLlmOverrides());
const gatewayEmbeddingProvider = buildEmbeddingProvider(resolvedConfig());

// Conversation chat provider (ADR 54): null when nothing is configured at all —
// the conversation core then answers with onboarding guidance instead of
// dialing a non-existent localhost default.
function buildGatewayChatProvider(): LLMProvider | null {
  const config = resolvedConfig();
  const hasConfigProviders = (config?.providers?.length ?? 0) > 0;
  const hasEnvProvider =
    process.env['LLM_BASE_URL'] !== undefined || process.env['LLM_API_KEY'] !== undefined;
  if (!hasConfigProviders && !hasEnvProvider) return null;
  return buildChatProvider(config);
}
const gatewayChatProvider = buildGatewayChatProvider();

/**
 * Build and return the Hono app with all routes mounted.
 *
 * @param pool  Injected SELECT/INSERT pool. In tests, a mock pool can be passed.
 *              In production, this is a real pg.Pool bound to the gateway DB user
 *              (SELECT + INSERT rights only — no DDL per ADR 24).
 */
export function buildApp(pool: Pool, ddlPool: Pool, wMax: number): Hono {
  const app = new Hono();

  // Realtime auth + connection rate limit (ADR-44 D-2/D-3): token from config
  // or MEMEX_GATEWAY_TOKEN; no-token mode only while bound to localhost.
  const realtimeToken = (): string | undefined =>
    process.env['MEMEX_GATEWAY_TOKEN'] ?? loadMemexConfig()?.gateway?.token;
  app.use('/v1/stream', realtimeAuth(realtimeToken));
  app.use('/ws', realtimeAuth(realtimeToken));
  // Conversation turns burn LLM tokens — same token gate as the realtime
  // surfaces (ADR-44 D-2: no-token mode only while bound to localhost), but
  // without the connection rate bucket (per-message endpoint).
  app.use('/v1/scopes/:id/chat', tokenAuth(realtimeToken));

  // Mount route modules
  app.route('/v1/scopes', buildScopesRoute(pool, ddlPool, wMax));
  app.route('/v1/scopes', buildEventsRoute(pool, wMax, gatewayEmbeddingProvider));
  app.route('/v1/scopes', buildChatRoute(pool, wMax, gatewayEmbeddingProvider, gatewayChatProvider));
  app.route('/v1/scopes', buildScopeReadRoute(pool, wMax));
  app.route('/v1', buildHealthRoute(pool));
  app.route('/v1', buildSysConfigRoute());
  app.route('/v1', buildTopologyRoute(pool));
  app.route('/v1', buildMemoryRoute(pool, gatewayEmbeddingProvider));
  app.route('/v1', buildStreamRoute(pool));
  app.route('/v1', buildForestRoute(pool));
  app.route('/v1', buildEmergenceRoute(pool));
  app.route('/v1', buildSkillsRoute());
  app.route('/v1', buildArtifactsRoute(pool));
  app.route('/v1', buildMetricsRoute(pool));
  app.route('/v1', buildDecisionsRoute(pool));
  // /ws is mounted by the production entry below — buildWsRoute is async
  // (dynamic 'hono/bun' import) and Bun-only; buildApp stays sync for tests.
  app.route('/', buildMcpRoute(pool));
  app.route('/', buildAgentsRoute(pool));
  app.route('/', buildDashboardRoute());

  // POST /pair/generate — admin-only; gated by GRAPH_RUNTIME_SECRET Bearer token
  app.post('/pair/generate', async (c) => {
    const secret = process.env['GRAPH_RUNTIME_SECRET'];
    if (secret) {
      const auth = c.req.header('Authorization');
      if (auth !== `Bearer ${secret}`) return c.json({ error: 'Unauthorized' }, 401);
    }
    const { agent_id } = (await c.req.json()) as { agent_id: string };
    const result = generatePairingCode(agent_id);
    if ('error' in result) {
      // TD-G hardening: 1 code / agent / 10 min
      return c.json({ error: result.error, retry_after_ms: result.retryAfterMs }, 429);
    }
    return c.json({ code: result.code, expires_in_s: TTL_SECONDS });
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

// Production entry point — env reads consolidated here (ADR 22).
// Config layering: ~/.memex/config.json (system-wide) overrides defaults;
// env vars override config (env is the operational escape hatch).
const memexConfig = loadMemexConfig();
// Phase 15 G5: per-profile database isolation — env stays the operational override.
const DATABASE_URL =
  process.env.DATABASE_URL ?? memexConfig?.database?.url ?? 'postgres://localhost:5432/graph';
const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });
const ddlPool = createDdlPool(DATABASE_URL);
const wMax = Number(process.env.CONTEXT_W_MAX ?? DEFAULT_W_MAX);

// TD-G: pairing persistence — write-through + boot warm (best-effort).
configurePairingPersistence(pool);
void warmPairingCache(pool).catch(() => {
  /* agent_pairing may not exist yet (pre-migration-014 DB) — in-memory path works */
});

const app = buildApp(pool, ddlPool, wMax);

const gatewayPort = Number(process.env.PORT ?? memexConfig?.gateway?.port ?? DEFAULT_GATEWAY_PORT);
// ADR-44 D-2: bind localhost by default — exposing the gateway is an explicit choice.
const gatewayHost = process.env.MEMEX_BIND ?? '127.0.0.1';

// ── Runtime split (TD-M, ADR-48): Node 22 is the primary supported runtime. ──
// Bun remains a compatibility branch — the same app + WS protocol behind a
// different upgrade adapter. Under vitest neither branch starts a server.
const isBun = typeof (globalThis as Record<string, unknown>)['Bun'] !== 'undefined';
let websocket: unknown;

if (isBun) {
  const ws = await buildWsRoute(pool, wMax, gatewayEmbeddingProvider, gatewayChatProvider);
  app.route('/', ws.app);
  websocket = ws.websocket;
} else if (!process.env['VITEST']) {
  // '@hono/node-ws' needs the same Hono instance that serve() runs — /ws is
  // registered on the main app, then the upgrade is injected into the server.
  const { serve } = await import('@hono/node-server');
  const { injectWebSocket } = await buildWsRouteNode(app, pool, wMax, gatewayEmbeddingProvider, gatewayChatProvider);
  const server = serve({ fetch: app.fetch, port: gatewayPort, hostname: gatewayHost });
  injectWebSocket(server);
}

logger.child({ component: 'gateway' }).info(
  { port: gatewayPort, host: gatewayHost, runtime: isBun ? 'bun' : 'node', url: `http://${gatewayHost}:${gatewayPort}` },
  'gateway.ready',
);

// Bun.serve consumes this default export (`bun run src/index.ts`); under Node
// the server is already started above and this export is inert.
export default {
  port: gatewayPort,
  hostname: gatewayHost,
  fetch: app.fetch,
  // Bun WS upgrade handler — same object upgradeWebSocket registered (ADR-44 D-1).
  websocket,
};

export { app };
