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
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';

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

// ── AgentCard validation schema ──────────────────────────────────────────────
const AgentCardBodySchema = z.object({
  agent_id: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  skills: z.array(z.string()).min(1),
  protocol: z.enum(['mcp', 'a2a', 'iii']),
  endpoint: z.string().optional(),
  version: z.string().optional(),
});

const UPSERT_AGENT_SQL = `
  INSERT INTO agent_registry
    (agent_id, name, description, skills, protocol, endpoint, agent_card_json, last_heartbeat, status)
  VALUES
    (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::text[], $5, $6, $7::jsonb, NOW(), 'active')
  ON CONFLICT (agent_id)
  DO UPDATE SET
    name            = EXCLUDED.name,
    description     = EXCLUDED.description,
    skills          = EXCLUDED.skills,
    protocol        = EXCLUDED.protocol,
    endpoint        = EXCLUDED.endpoint,
    agent_card_json = EXCLUDED.agent_card_json,
    last_heartbeat  = NOW(),
    status          = 'active'
  RETURNING agent_id
`;

export function buildAgentsRoute(pool: Pool): Hono {
  const app = new Hono();

  // ── POST /v1/agents/register ─────────────────────────────────────────────
  app.post('/v1/agents/register', zValidator('json', AgentCardBodySchema), async (c) => {
    const card = c.req.valid('json');

    try {
      const result = await pool.query<{ agent_id: string }>(UPSERT_AGENT_SQL, [
        card.agent_id ?? null,
        card.name,
        card.description ?? null,
        card.skills,
        card.protocol,
        card.endpoint ?? null,
        JSON.stringify(card),
      ]);

      const agentId = result.rows[0]?.agent_id ?? card.agent_id ?? 'unknown';
      return c.json({ success: true, agent_id: agentId }, 201);
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
