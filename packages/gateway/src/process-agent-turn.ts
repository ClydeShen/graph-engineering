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
import { isScopeColdStart, type EmbeddingProvider } from '@graph/shared';
import { memReflect, type MemReflectInput } from '@graph/workers/memory/reflect.function';

/**
 * Extract a short, retrieval-relevant string from an event payload for mem::reflect's
 * query_text (WR-01/WR-03, 09-REVIEW.md). Prefers known descriptive fields over
 * serializing the entire payload, which can be large/arbitrary nested JSON and
 * degrades BM25 (plainto_tsquery) and embedding relevance.
 */
function extractQueryText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['description', 'intent', 'summary', 'output', 'content', 'message', 'text']) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  const json = JSON.stringify(payload);
  return json.length > 500 ? json.slice(0, 500) : json;
}

export type AgentEventInput = z.infer<typeof EventBodySchema>;

export type AgentTurnOutcome =
  | { suspended: true }
  | { suspended: false; version_hash: string; occ_result: string; context: AssembledContext | null };

export async function processAgentTurn(
  pool: Pool,
  scopeId: string,
  event: AgentEventInput,
  wMax: number,
  embeddingProvider: EmbeddingProvider,
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

    // cold_start Reflection Track injection (D-10): production wiring.
    if (context !== null && !scopeClosed) {
      if (await isScopeColdStart(pool, scopeId)) {
        const reflection = await memReflect(pool, embeddingProvider, {
          query_text: extractQueryText(event.payload),
          trigger_type: 'cold_start',
          w_max: wMax,
          scope_id: scopeId,
        } satisfies MemReflectInput);
        context.reflectionContent = reflection.content;
        context.reflectionTokens = reflection.tokens;
      }
    }

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
