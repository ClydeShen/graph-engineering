/**
 * AgentCard routes — external agent registration + graph-os self AgentCard.
 *
 *   POST /v1/agents/register      — register an external Agent's AgentCard
 *   GET  /.well-known/agent-card.json — graph-os's own static AgentCard (no DB)
 *
 * @see .harness/phases/side-branch/DESIGN.md §3.3 + §3.4
 * @see ADR 42 — multi-agent coordination layer (Phase 3 scope)
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { zValidator } from '@hono/zod-validator';
import { AgentCardSchema, registerAgent } from '../agent-registry.js';

// ── graph-os self AgentCard (DESIGN.md §3.4) ────────────────────────────────
const GRAPH_OS_AGENT_CARD = {
  name: 'graph-os',
  description: 'Causal execution graph runtime. Routes tasks, assembles context, persists cognitive state.',
  skills: ['task-routing', 'context-assembly', 'memory-retrieval', 'pattern-discovery'],
  protocol: 'mcp',
  endpoint: '/mcp/messages',
  version: '1.0',
  protocols: ['mcp', 'a2a'],
  endpoints: {
    mcp: '/mcp/messages',
    a2a: '/a2a/rpc',
    agent_card: '/.well-known/agent-card.json',
  },
} as const;


export function buildAgentsRoute(pool: Pool): Hono {
  const app = new Hono();

  // ── POST /v1/agents/register ─────────────────────────────────────────────
  app.post('/v1/agents/register', zValidator('json', AgentCardSchema), async (c) => {
    const card = c.req.valid('json');

    try {
      const { agent_id } = await registerAgent(pool, card);
      return c.json({ success: true, agent_id }, 201);
    } catch (err) {
      return c.json(
        { error: 'Failed to register agent', detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }
  });

  // ── GET /.well-known/agent-card.json ────────────────────────────────────
  // Static — no DB required. Returns graph-os's own AgentCard (DESIGN.md §3.4).
  app.get('/.well-known/agent-card.json', (c) => {
    return c.json(GRAPH_OS_AGENT_CARD, 200);
  });

  return app;
}
