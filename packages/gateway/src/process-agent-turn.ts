/**
 * processAgentTurn — domain function for the agent event write path.
 *
 * Extracts the five concerns from buildEventsRoute into a testable pure function:
 *   1. Scope suspended lockout (ADR 39)
 *   2. OCC write (ADR 11)
 *   3. Inline Watchdog convergence check (ADR 19 Tier 3)
 *   4. scope_closed write if converged (ADR 24 infra-write right #1)
 *   5. Context assembly (ADR 13 + ADR 30)
 *
 * Callable from tests, CLI tools, and future non-HTTP transports without a Hono mock.
 *
 * @see ADR 24 — HTTP Gateway spec
 */

import type { Pool } from 'pg';
import type { z } from 'zod';
import { EventBodySchema } from '@shared/schemas';
import { occWrite } from '@shared/occ-write';
import { logger, LOG_EVENTS } from '@shared/logger';
import {
  checkSuspended,
  checkConvergence,
  writeScopeClosed,
  writeContextOomThrottled,
} from './watchdog-sql.js';
import { assembleContext, type AssembledContext } from '@graph/workers/context/assemble';
import { makeKnapsackGraph } from './knapsack-graph.js';

export type AgentEventInput = z.infer<typeof EventBodySchema>;

export type AgentTurnOutcome =
  | { suspended: true }
  | { suspended: false; version_hash: string; occ_result: string; context: AssembledContext | null };

export async function processAgentTurn(
  pool: Pool,
  scopeId: string,
  event: AgentEventInput,
  wMax: number,
): Promise<AgentTurnOutcome> {
  // 1. Suspended lockout (ADR 39)
  if (await checkSuspended(pool, scopeId)) {
    logger.child({ component: 'gateway', scope_id: scopeId }).warn(
      LOG_EVENTS.SCOPE_SUSPENDED_LOCKOUT,
    );
    return { suspended: true };
  }

  // 2. OCC write
  const { version_hash, occ_result } = await occWrite(pool, {
    scopeId,
    entityId: event.entity_id,
    predecessorHash: event.predecessor_hash,
    eventType: event.event_type,
    payload: event.payload,
  });

  // 3. Inline Watchdog (ADR 19 Tier 3)
  const { isConverged, noOpenConflicts } = await checkConvergence(pool, scopeId);

  // 4. scope_closed if converged (ADR 24 infra-write right #1)
  let scopeClosed = false;
  if (isConverged && noOpenConflicts) {
    await writeScopeClosed(pool, scopeId);
    scopeClosed = true;
  }

  // 5. Context assembly
  try {
    const graph = await makeKnapsackGraph(pool, scopeId, { bypassView: true });
    const context = await assembleContext(graph, scopeId, version_hash, event.payload, wMax, scopeClosed);
    return { suspended: false, version_hash, occ_result, context };
  } catch (oomErr) {
    logger.child({ component: 'gateway', scope_id: scopeId }).error(
      { err: oomErr instanceof Error ? oomErr.message : String(oomErr) },
      LOG_EVENTS.CONTEXT_OOM,
    );
    await writeContextOomThrottled(pool, scopeId);
    return { suspended: false, version_hash, occ_result, context: null };
  }
}
