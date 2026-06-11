/**
 * MCP transport route — mounts the McpServer via WebStandardStreamableHTTPServerTransport.
 *
 * Protocol: MCP Streamable HTTP (2025-11-25 spec)
 *   GET  /mcp/sse                — SSE push stream (latency optimization only; carries no
 *                                  task content per D-4)
 *   *    /mcp, /mcp/messages     — JSON-RPC tool call entry point (same handler, two paths)
 *
 * Why two paths for the same handler: several MCP clients (e.g. the official inspector's
 * --cli mode) pick a transport purely from the URL string — `*\/mcp` => Streamable HTTP,
 * `*\/sse` => legacy SSE, anything else => legacy SSE (a guess, not a protocol probe). Against
 * the documented `/mcp/messages` URL that guess is always wrong, so a standard client connects
 * with the legacy SSE transport and hangs/404s. `/mcp` is the spec's own canonical single-endpoint
 * path (see the SDK example cited below) and satisfies that heuristic; `/mcp/messages` stays as
 * the existing documented alias for current callers/tests. Purely additive — does not change
 * `/mcp/sse`'s D-4 role.
 *
 * STATELESS MODE: fresh transport + server per request (SDK requirement).
 * WebStandardStreamableHTTPServerTransport sets _hasHandledRequest=true after the
 * first call and throws on any subsequent call in stateless mode (sessionIdGenerator: undefined).
 * The McpServer also guards against double connect() with "Already connected" error.
 * Solution: create fresh instances per request, closing over the shared pool.
 *
 * @see node_modules/@modelcontextprotocol/sdk/dist/cjs/examples/server/honoWebStandardStreamableHttp.js
 * @see ADR 24 — HTTP Gateway spec
 */

import { Hono, type Handler } from 'hono';
import type { Pool } from 'pg';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '../mcp/server.js';
import { isPaired } from '../auth/pairing.js';
import { isToolAllowed } from '@graph/shared';
import type { TrustLevel } from '@graph/types/core';

export function buildMcpRoute(pool: Pool): Hono {
  const app = new Hono();

  // ── REQUIRE_AGENT_PAIRING middleware (Phase 6 T5) ──────────────────────
  // When REQUIRE_AGENT_PAIRING=true, every MCP request must present X-Agent-ID
  // from a paired agent. Pairing is established via POST /pair. Single-process
  // only — see pairing.ts implementation notes.
  const pairingGuard: Handler = async (c, next) => {
    if (process.env['REQUIRE_AGENT_PAIRING'] !== 'true') return next();
    const agentId = c.req.header('X-Agent-ID');
    if (!agentId || !isPaired(agentId)) {
      return c.json({ error: 'Agent not paired. POST /pair with your pairing code.' }, 401);
    }
    return next();
  };
  app.use('/mcp/sse', pairingGuard);
  app.use('/mcp', pairingGuard);
  app.use('/mcp/messages', pairingGuard);

  // ── GET /mcp/sse — SSE push stream ─────────────────────────────────────
  // D-4: SSE carries no task content, only availability signals.
  app.get('/mcp/sse', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = buildMcpServer(pool);
    await mcpServer.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  // ── /mcp, /mcp/messages — JSON-RPC tool call entry point (all methods) ──
  // app.all() (not .post-only): matches the SDK's own canonical example
  // (honoWebStandardStreamableHttp.js) — every HTTP method is routed through
  // the same transport.handleRequest() so GET-based session/SSE negotiation
  // works too. Two paths, one handler: `/mcp` is the spec's canonical
  // single-endpoint convention (and what URL-guessing clients expect);
  // `/mcp/messages` remains for existing references — see file header.
  // Registered twice rather than via an array path: this Hono build (4.12.23)
  // 404s on array-form `app.all([...], handler)` (verified — both paths return
  // 404 — while two single-path `app.all(path, handler)` calls work correctly).
  const handleMcpRequest: Handler = async (c) => {
    // ── Trust → toolset enforcement (ADR-47 D-7) ────────────────────────────
    // Defense-in-depth, not the boundary (containers are, D-4). POST bodies are
    // inspected for tools/call; the agent's trust_level (agent_registry, keyed
    // by X-Agent-ID) gates the tool. No header = local single-tenant caller:
    // trusted when pairing is off (pairing guarantees the header otherwise).
    let request = c.req.raw;
    if (c.req.method === 'POST') {
      const bodyText = await c.req.text();
      try {
        const rpc = JSON.parse(bodyText) as { method?: string; params?: { name?: string } };
        if (rpc.method === 'tools/call' && typeof rpc.params?.name === 'string') {
          const agentId = c.req.header('X-Agent-ID');
          let trust: TrustLevel = 'trusted';
          if (agentId !== undefined) {
            const { rows } = await pool.query<{ trust_level: TrustLevel }>(
              `SELECT trust_level FROM agent_registry WHERE agent_id = $1`,
              [agentId],
            );
            trust = rows.length > 0 ? rows[0]!.trust_level : 'untrusted';
          }
          if (!isToolAllowed(trust, rpc.params.name)) {
            return c.json(
              {
                jsonrpc: '2.0',
                id: (rpc as { id?: unknown }).id ?? null,
                error: { code: -32001, message: `tool '${rpc.params.name}' not permitted at trust level '${trust}'` },
              },
              200,
            );
          }
        }
      } catch {
        /* non-JSON body — let the transport reject it */
      }
      request = new Request(c.req.raw.url, {
        method: 'POST',
        headers: c.req.raw.headers,
        body: bodyText,
      });
    }

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = buildMcpServer(pool);
    try {
      await mcpServer.connect(transport);
      return await transport.handleRequest(request);
    } catch (err) {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } },
        200,
      );
    }
  };
  app.all('/mcp', handleMcpRequest);
  app.all('/mcp/messages', handleMcpRequest);

  return app;
}
