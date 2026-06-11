/**
 * POST /v1/scopes/:id/events — HTTP adapter for processAgentTurn.
 *
 * This route is intentionally thin: Zod gate + UUID validation + HTTP response shaping.
 * All domain logic lives in processAgentTurn (packages/gateway/src/process-agent-turn.ts).
 *
 * @see ADR 24 — HTTP Gateway spec (infra-write rights, Zod gate)
 * @see packages/gateway/src/process-agent-turn.ts — domain logic
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { zValidator } from '@hono/zod-validator';
import { EventBodySchema } from '@shared/schemas';
import type { EmbeddingProvider } from '@graph/shared';
import { validateScopeIdParam } from '../middleware/zod-guard.js';
import { processAgentTurn } from '../process-agent-turn.js';

export function buildEventsRoute(pool: Pool, wMax: number, embeddingProvider: EmbeddingProvider): Hono {
  const app = new Hono();

  app.post('/:id/events', zValidator('json', EventBodySchema), async (c) => {
    const id = c.req.param('id');
    const invalid = validateScopeIdParam(c, id);
    if (invalid) return invalid;

    const result = await processAgentTurn(pool, id, c.req.valid('json'), wMax, embeddingProvider);

    if (result.suspended) {
      return c.json({ error: 'scope suspended', scope_status: 'suspended' }, 409);
    }

    const { version_hash, occ_result, context } = result;
    return c.json({
      version_hash,
      occ_result,
      context: context?.context === null ? null : context,
    });
  });

  return app;
}
