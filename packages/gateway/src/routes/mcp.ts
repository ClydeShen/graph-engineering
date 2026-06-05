/**
 * MCP transport route — mounts the McpServer via WebStandardStreamableHTTPServerTransport.
 *
 * Protocol: MCP Streamable HTTP (2025-11-25 spec)
 *   GET  /mcp/sse      — SSE push stream (latency optimization only; carries no task content per D-4)
 *   POST /mcp/messages — JSON-RPC tool calls
 *
 * ONE McpServer + ONE transport (stateless, sessionIdGenerator: undefined).
 * Created once in buildMcpRoute() and shared across all requests (Pitfall 2).
 *
 * @see .planning/phases/03-pattern-discovery/03-RESEARCH.md §Pattern 1 + §Pitfall 2
 * @see ADR 24 — HTTP Gateway spec
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer } from '../mcp/server.js';

export function buildMcpRoute(pool: Pool): Hono {
  const app = new Hono();

  // Create ONE McpServer + ONE transport (stateless) — shared across all requests (Pitfall 2).
  const mcpServer = buildMcpServer(pool);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode — no per-session state
    enableJsonResponse: true,      // return JSON for POST (not SSE stream) for simpler test assertions
  });

  // Connect server to transport once at boot
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  mcpServer.connect(transport);

  // ── GET /mcp/sse — SSE push stream ─────────────────────────────────────
  // D-4: SSE carries no task content, only availability signals.
  // The SDK transport handles SSE framing via handleRequest on GET.
  app.get('/mcp/sse', async (c) => {
    const response = await transport.handleRequest(c.req.raw);
    return response;
  });

  // ── POST /mcp/messages — JSON-RPC tool call entry point ─────────────────
  app.post('/mcp/messages', async (c) => {
    const response = await transport.handleRequest(c.req.raw);
    return response;
  });

  return app;
}
