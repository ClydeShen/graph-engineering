/**
 * MCP transport route — mounts the McpServer via WebStandardStreamableHTTPServerTransport.
 *
 * Protocol: MCP Streamable HTTP (2025-11-25 spec)
 *   GET  /mcp/sse      — SSE push stream (latency optimization only; carries no task content per D-4)
 *   POST /mcp/messages — JSON-RPC tool calls
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

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '../mcp/server.js';

export function buildMcpRoute(pool: Pool): Hono {
  const app = new Hono();

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

  // ── POST /mcp/messages — JSON-RPC tool call entry point ─────────────────
  app.post('/mcp/messages', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcpServer = buildMcpServer(pool);
    try {
      await mcpServer.connect(transport);
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      return c.json(
        { jsonrpc: '2.0', id: null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } },
        200,
      );
    }
  });

  return app;
}
