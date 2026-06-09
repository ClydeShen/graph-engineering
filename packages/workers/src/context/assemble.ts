/**
 * 3-layer prompt assembler for context assembly.
 *
 * Produces { stable, context, volatile } within the W_max token budget.
 * Graph → Context is a ONE-WAY projection — this module NEVER mutates the graph.
 *
 * Layer 1 (Stable):  System role string. Cache-eligible across Anthropic API calls.
 *                    Keep stable — do not vary per invocation (ADR 30 D-1).
 * Layer 2 (Context): Knapsack causal lineage projection. Overflow handled by
 *                    ReverseChronologicalDiscarder (Zero-LLM, ADR 30 D-2).
 * Layer 3 (Volatile): Current input payload. Rebuilt every invocation.
 *
 * @see ADR 30 (Context Assembly Strategy)
 * @see ADR 24 (Agent Entry-Point Protocol — scope_closed → context=null)
 */

import type { EventLogNode } from '@shared/types';
import { countTokens } from '@shared/tokenizer';
import { knapsackSlice, type KnapsackGraph } from './knapsack.js';
import { ReverseChronologicalDiscarder } from './overflow.js';

const OVERFLOW_DISCARDER = new ReverseChronologicalDiscarder();

/**
 * The 3-layer assembled context.
 * context is null when the scope is closed (signals Agent to terminate).
 */
export interface AssembledContext {
  /** Layer 1: stable system role. Anthropic prompt-cache eligible — keep constant. */
  stable: string;
  /**
   * Layer 2: causal lineage projection (newest-first, within budget).
   * null signals scope_closed — consuming Agent MUST terminate (ADR 24).
   */
  context: EventLogNode[] | null;
  /** Layer 3: current input serialized. Rebuilt every invocation. */
  volatile: string;
}

/**
 * System role string for Layer 1 (Stable).
 *
 * IMPORTANT: This string MUST remain stable across invocations to benefit from
 * Anthropic prompt caching. Do not embed per-request data here.
 * @see ADR 30 D-1
 */
export const STABLE_SYSTEM_ROLE =
  'You are a graph-native agent operating on an append-only Execution Graph. ' +
  'Your context window is a read-time projection of the graph state. ' +
  'All persistent writes occur through the GraphHandle write interface only. ' +
  'Context overflow is handled by the sliding-window discarder — older events ' +
  'are dropped, not summarized. Retrieve older context via graph queries if needed.';

/**
 * Assemble a 3-layer prompt within the W_max token budget.
 *
 * Budget allocation:
 *   stable_tokens  = countTokens(stable)
 *   volatile_tokens = countTokens(volatile)
 *   context_budget  = wMax - stable_tokens - volatile_tokens
 *
 * If the knapsack result exceeds context_budget, ReverseChronologicalDiscarder
 * trims it (newest events retained, oldest dropped — Zero-LLM).
 *
 * On scope_closed: returns context=null to signal Agent termination (ADR 24).
 *
 * @param graph        Read-only graph accessor.
 * @param scopeId      The active Scope UUID.
 * @param rootHash     version_hash of the most-recent event (N_current).
 * @param currentInput The Worker's current input payload object.
 * @param wMax         Maximum token budget for the entire assembled prompt.
 * @param scopeClosed  When true, context=null is returned immediately.
 */
export async function assembleContext(
  graph: KnapsackGraph,
  scopeId: string,
  rootHash: string,
  currentInput: unknown,
  wMax: number,
  scopeClosed = false
): Promise<AssembledContext> {
  const stable = STABLE_SYSTEM_ROLE;
  const volatile = JSON.stringify(currentInput);

  // scope_closed: signal Agent to terminate (ADR 24).
  // Gateway consumes context=null and closes the agent loop (Plan 07).
  if (scopeClosed) {
    return { stable, context: null, volatile };
  }

  const stableTokens = countTokens(stable);
  const volatileTokens = countTokens(volatile);
  const contextBudget = Math.max(0, wMax - stableTokens - volatileTokens);

  // Layer 2: Knapsack causal lineage projection
  // dropped is available for Phase 08 CCR marker injection; ignored here (ADR 13 supplement)
  let contextEvents = (await knapsackSlice(graph, scopeId, rootHash, contextBudget)).kept;

  // Apply overflow discarder if knapsack result exceeds remaining budget
  const contextTokens = contextEvents.reduce(
    (sum, e) => sum + countTokens(e.payload),
    0
  );
  if (contextTokens > contextBudget) {
    contextEvents = OVERFLOW_DISCARDER.discard(contextEvents, contextBudget);
  }

  return { stable, context: contextEvents, volatile };
}
