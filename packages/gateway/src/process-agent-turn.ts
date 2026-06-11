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
import { insertWorkingMemory } from '@graph/workers/memory/working-memory';
import { recordTemplateInjection } from '@graph/workers/memory/template-injection';

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
  | { suspended: false; deduplicated: true }
  | { suspended: false; deduplicated?: false; version_hash: string; occ_result: string; context: AssembledContext | null };

export async function processAgentTurn(
  pool: Pool,
  scopeId: string,
  event: AgentEventInput,
  wMax: number,
  embeddingProvider: EmbeddingProvider,
  /**
   * Requesting principal from X-Agent-ID (ADR-46 D-4). Merged into the payload
   * as `_principal` BEFORE the OCC write, so a demoted write's conflict_detected
   * row carries the loser's identity — cross-agent conflicts become attributable
   * Trail data without changing hash semantics.
   */
  principal?: string,
): Promise<AgentTurnOutcome> {
  // 1. Suspended lockout (ADR 39)
  if (await checkSuspended(pool, scopeId)) {
    logger.child({ component: 'gateway', scope_id: scopeId }).warn(
      LOG_EVENTS.SCOPE_SUSPENDED_LOCKOUT,
    );
    return { suspended: true };
  }

  // 1b. TD-B dedup window (ADR-11 supplement): block semantically duplicate
  // memory_updated writes within 5 minutes, even under different predecessors —
  // the OCC unique constraint cannot catch those (dedup hash excludes
  // predecessor_hash by design). Restricted to memory_updated: tool results land
  // as memory_updated and are the high-frequency duplication source; lifecycle
  // events (plan_created/scope_closed/conflict_detected) are never deduped.
  if (event.event_type === 'memory_updated') {
    const { inserted } = await insertWorkingMemory(
      pool,
      scopeId,
      event.entity_id,
      event.event_type,
      JSON.stringify(event.payload),
    );
    if (!inserted) {
      logger.child({ component: 'gateway', scope_id: scopeId }).info(
        LOG_EVENTS.WORKING_MEMORY_DEDUP,
      );
      return { suspended: false, deduplicated: true };
    }
  }

  // 2. OCC write — attribution merge happens AFTER the dedup check (the tool
  // result's content identity must not vary by submitter).
  const attributedPayload =
    principal !== undefined && event.payload !== null && typeof event.payload === 'object'
      ? { ...(event.payload as Record<string, unknown>), _principal: principal }
      : event.payload;

  const { version_hash, occ_result } = await occWrite(pool, {
    scopeId,
    entityId: event.entity_id,
    predecessorHash: event.predecessor_hash,
    eventType: event.event_type,
    payload: attributedPayload,
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

    // Reflection Track injection — trigger selection (ADR-21, Phase 10 完整接线):
    //   cold_start         — first turn of the scope (highest precedence)
    //   conflict_detected  — this write lost the OCC race (occ_result='demoted')
    //   macro_planning     — a task_spawned event. plan_created never traverses
    //                        this route (EventBodySchema restricts agents to
    //                        task_spawned|memory_updated; plan_created is written
    //                        at scope creation, which is cold_start by definition).
    //                        Spawning sub-tasks IS the in-scope planning act.
    if (context !== null && !scopeClosed) {
      let triggerType: MemReflectInput['trigger_type'] | null = null;
      if (await isScopeColdStart(pool, scopeId)) {
        triggerType = 'cold_start';
      } else if (occ_result === 'demoted') {
        triggerType = 'conflict_detected';
      } else if (event.event_type === 'task_spawned') {
        triggerType = 'macro_planning';
      }

      if (triggerType !== null) {
        const reflection = await memReflect(pool, embeddingProvider, {
          query_text: extractQueryText(event.payload),
          trigger_type: triggerType,
          w_max: wMax,
          scope_id: scopeId,
        } satisfies MemReflectInput);
        context.reflectionContent = reflection.content;
        context.reflectionTokens = reflection.tokens;

        // Reinforcement-loop write side (migration 013): record which templates
        // were injected so converged closure can credit them (success_count+1).
        if (reflection.proceduralIds.length > 0) {
          await recordTemplateInjection(pool, scopeId, reflection.proceduralIds, triggerType);
        }
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
