/**
 * POST /v1/scopes/:id/events — submit an event to an existing Scope.
 *
 * Gateway infra-write rights (ADR 24):
 *   - scope_closed      → written when inline Watchdog SQL confirms convergence
 *   - context_oom_throttled → written when assembleContext signals OOM (Tier 3)
 * Gateway does NOT hold DDL rights — those stay with the Control Plane Daemon.
 *
 * Flow:
 *   1. Zod validates scope UUID param + event body (400 before DB, ADR 24)
 *   2. occWrite(pool, { scopeId, entityId, predecessorHash, payload })
 *   3. checkConvergence(pool, scopeId) — inline Watchdog SQL (ADR 19 Tier 3)
 *   4. If converged AND no open conflicts → writeScopeClosed (infra-write right #1)
 *   5. assembleContext — build Knapsack context
 *   6. If scope closed → { version_hash, occ_result, context: null }
 *      (signals Agent to terminate, ADR 24)
 *   7. Else → { version_hash, occ_result, context }
 *
 * @see ADR 24 — HTTP Gateway spec (infra-write rights, Zod gate)
 * @see ADR 11 — OCC Writable CTE
 * @see ADR 19 — Convergence Watchdog Tier 3 (inline SQL)
 * @see ADR 13 — Knapsack Slicing (context assembly)
 * @see REQ-15 — POST /v1/scopes/:id/events endpoint
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { zValidator } from '@hono/zod-validator';
import { EventBodySchema } from '@shared/schemas';
import { occWrite } from '@shared/occ-write';
import { logger, LOG_EVENTS } from '@shared/logger';
import { validateScopeIdParam } from '../middleware/zod-guard.js';
import {
  checkConvergence,
  writeScopeClosed,
  writeContextOomThrottled,
} from '../watchdog-sql.js';
import { assembleContext } from '@graph/workers/context/assemble';
import type { KnapsackGraph } from '@graph/workers/context/knapsack';
import type { EventLogNode } from '@shared/types';

/**
 * Build the events route.
 *
 * @param pool  SELECT/INSERT pool — used for OCC write, Watchdog SQL, context queries.
 *              This pool has NO DDL rights (ADR 24).
 * @param wMax  Context assembly token budget (read from env at boot, ADR 22).
 */
export function buildEventsRoute(pool: Pool, wMax: number): Hono {
  const app = new Hono();

  /**
   * POST /v1/scopes/:id/events
   * Body: EventBodySchema
   * Response:
   *   { version_hash, occ_result, context }         — scope is active
   *   { version_hash, occ_result, context: null }   — scope_closed (terminate signal)
   */
  app.post('/:id/events', zValidator('json', EventBodySchema), async (c) => {
    const id = c.req.param('id');

    // ── Step 1: Zod gate — UUID validation BEFORE any DB access (ADR 24) ────
    const invalid = validateScopeIdParam(c, id);
    if (invalid) return invalid;

    const { event_type, entity_id, predecessor_hash, payload } = c.req.valid('json');

    // ── Step 1b: Suspended lockout (ADR 39) ───────────────────────────────────
    // Reject all non-privileged writes to suspended scopes. Gateway infra-writes
    // (writeScopeClosed, writeContextOomThrottled) bypass this check because they
    // are direct pool.query() calls, not routed through this endpoint.
    const scopeRow = await pool.query<{ status: string }>(
      'SELECT status FROM scope_lineage WHERE scope_id = $1',
      [id],
    );
    if (scopeRow.rows[0]?.status === 'suspended') {
      logger.child({ component: 'gateway', scope_id: id }).warn(
        LOG_EVENTS.SCOPE_SUSPENDED_LOCKOUT,
      );
      return c.json({ error: 'scope suspended', scope_status: 'suspended' }, 409);
    }

    // ── Step 2: OCC write ─────────────────────────────────────────────────────
    const writeResult = await occWrite(pool, {
      scopeId: id,
      entityId: entity_id,
      predecessorHash: predecessor_hash,
      eventType: event_type,
      payload,
    });

    const { version_hash, occ_result } = writeResult;

    // ── Step 3: Inline Watchdog SQL (ADR 19 Tier 3) ───────────────────────────
    const { isConverged, noOpenConflicts } = await checkConvergence(pool, id);

    // ── Step 4: If converged → write scope_closed (infra-write right #1, ADR 24)
    let scopeClosed = false;
    if (isConverged && noOpenConflicts) {
      await writeScopeClosed(pool, id);
      scopeClosed = true;
    }

    // ── Step 5: Assemble Knapsack context ──────────────────────────────────────
    // On scope_closed, assembleContext returns context=null (ADR 24 + ADR 30).
    const eventCache = new Map<string, EventLogNode>();

    const graph: KnapsackGraph = {
      getEventByHash(hash: string): EventLogNode | undefined {
        return eventCache.get(hash);
      },
      getSiblings(_scopeId: string, _excludeHash: string): EventLogNode[] {
        return [];
      },
    };

    let assembledContext;
    try {
      // Pre-populate cache with the current causal chain for context assembly
      const chainResult = await pool.query<EventLogNode>(
        `SELECT id, scope_id, entity_id, event_type, predecessor_hash,
                version_hash, payload, status, base_priority, unlocks_count,
                spawned_by, last_active_at, created_at
         FROM execution_event_log
         WHERE scope_id = $1
         ORDER BY id ASC`,
        [id],
      );
      for (const row of chainResult.rows) {
        eventCache.set(row.version_hash, row);
      }

      assembledContext = await assembleContext(
        graph,
        id,
        version_hash,
        payload,
        wMax,
        scopeClosed,
      );
    } catch (oomErr) {
      // Context assembly OOM — Gateway infra-write right #2: context_oom_throttled (ADR 24)
      logger.child({ component: 'gateway', scope_id: id }).error(
        { err: oomErr instanceof Error ? oomErr.message : String(oomErr) },
        LOG_EVENTS.CONTEXT_OOM,
      );
      await writeContextOomThrottled(pool, id);
      // Return null context to signal Agent to terminate / degrade
      return c.json({ version_hash, occ_result, context: null });
    }

    // ── Step 6 / 7: Return response ───────────────────────────────────────────
    // context=null when scope_closed — signals Agent to terminate (ADR 24)
    return c.json({
      version_hash,
      occ_result,
      context: assembledContext.context === null ? null : assembledContext,
    });
  });

  return app;
}
