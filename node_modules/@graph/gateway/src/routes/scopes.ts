/**
 * POST /v1/scopes — create a new Scope.
 *
 * Delegates the 3-phase DDL nesting protocol to the Control Plane's nestScope().
 * The Gateway does NOT issue DDL directly — that exclusive right belongs to
 * the Control Plane Daemon (ADR 05, ADR 24).
 *
 * Flow:
 *   1. Zod validates body (intent: string 1–4096 chars)
 *   2. nestScope(intent) → { scopeId, planHash } (3-phase DDL nesting)
 *   3. assembleContext with planHash as rootHash
 *   4. Return 201 { scope_id, plan_hash, context }
 *
 * @see ADR 05 — 3-phase nesting protocol (DDL exclusive to Control Plane)
 * @see ADR 24 — HTTP Gateway spec; Gateway delegates DDL to Control Plane
 * @see REQ-15 — POST /v1/scopes endpoint
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { zValidator } from '@hono/zod-validator';
import { CreateScopeSchema } from '@shared/schemas';
import { nestScope } from '@graph/control-plane/nesting';
import { assembleContext } from '@graph/workers/context/assemble';
import type { KnapsackGraph } from '@graph/workers/context/knapsack';
import { logger, LOG_EVENTS } from '@shared/logger';

const log = logger.child({ component: 'gateway', route: 'POST /v1/scopes' });

/** Default W_max token budget for initial context assembly (configurable). */
const DEFAULT_W_MAX = 4096;

/**
 * Build the scopes route.
 *
 * @param _pool  SELECT/INSERT pool (not used for POST /v1/scopes — nestScope uses
 *               the DDL pool internally; provided for future GET /v1/scopes queries)
 */
export function buildScopesRoute(_pool: Pool): Hono {
  const app = new Hono();

  /**
   * POST /v1/scopes
   * Body: { intent: string }
   * Response: 201 { scope_id, plan_hash, context }
   */
  app.post('/', zValidator('json', CreateScopeSchema), async (c) => {
    const { intent } = c.req.valid('json');

    // Delegates DDL nesting to Control Plane — Gateway has no DDL rights (ADR 24)
    const { scopeId, planHash } = await nestScope(intent);
    log.info({ scope_id: scopeId, plan_hash: planHash }, LOG_EVENTS.SCOPE_CREATED);

    // Assemble initial context for the newly created scope.
    // The graph is empty except for plan_created — provide a no-op KnapsackGraph.
    const emptyGraph: KnapsackGraph = {
      getEventByHash: () => undefined,
      getSiblings: () => [],
    };

    const wMax = Number(process.env.CONTEXT_W_MAX ?? DEFAULT_W_MAX);
    const context = await assembleContext(
      emptyGraph,
      scopeId,
      planHash,
      { intent },
      wMax,
    );

    return c.json({ scope_id: scopeId, plan_hash: planHash, context }, 201);
  });

  return app;
}
