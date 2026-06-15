/**
 * buildMcpServer — registers the MCP tools as cognitive-translation adapters over
 * the existing causal ledger (OCC writes + SKIP LOCKED claims).
 *
 * This is the thin MCP-over-HTTP adapter: it loops the tool registry
 * (`mcp/tools/`) and registers each enabled tool. Each tool's name, schema, and
 * handler live in its own deep module — the same factories can be adapted to
 * other surfaces (in-process Pi, ADR-57) without re-declaring the handler. The
 * server instance is created once and reused across requests (Pitfall 2).
 *
 * Tools expose only the two agent-writable canonical event types (ADR 12):
 *   task_spawned  — written by spawn_subtask
 *   memory_updated — written by complete_task
 *
 * @see ADR 12 — five canonical event types (no new type introduced here)
 * @see ADR 31 — FrontierScheduler skill-routing (D-1)
 * @see ADR 53 — autonomous-assistant tool family (autonomy.ts)
 * @see ADR 57 — in-process Pi reuses the same tool definitions
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { TOOL_FACTORIES } from './tools/index.js';

// COMMAND GATE: any tool that executes user-supplied shell commands MUST call
// checkCommand() before execution. See packages/shared/src/command-gate.ts.
// (Enforced inside runExecuteBash — the shared execute_bash implementation.)

/**
 * Build a McpServer with every enabled tool registered. Trust gating happens at
 * the HTTP MCP route (isToolAllowed interception), not here.
 */
export function buildMcpServer(pool: Pool): McpServer {
  const server = new McpServer({ name: 'graph-os', version: '1.0.0' });
  for (const factory of TOOL_FACTORIES) {
    const tool = factory(pool);
    if (tool === null) continue; // env-gated tool disabled for this process
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
  }
  return server;
}
