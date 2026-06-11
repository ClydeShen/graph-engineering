import type { Pool } from 'pg';
import { z } from 'zod';

export const AgentCardSchema = z.object({
  agent_id: z.string().uuid().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  skills: z.array(z.string()).min(1),
  protocol: z.enum(['mcp', 'a2a', 'iii']),
  endpoint: z.string().optional(),
  version: z.string().optional(),
});

export type AgentCardInput = z.infer<typeof AgentCardSchema>;

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

export async function registerAgent(pool: Pool, card: AgentCardInput): Promise<{ agent_id: string }> {
  const result = await pool.query<{ agent_id: string }>(UPSERT_AGENT_SQL, [
    card.agent_id ?? null,
    card.name,
    card.description ?? null,
    card.skills,
    card.protocol,
    card.endpoint ?? null,
    JSON.stringify(card),
  ]);
  return { agent_id: result.rows[0]?.agent_id ?? card.agent_id ?? 'unknown' };
}
