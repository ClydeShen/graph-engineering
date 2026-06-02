/**
 * Knapsack Slicing — causal skeleton context projection.
 *
 * Assembles a token-budget-aware slice of the Execution Graph for context assembly.
 * Graph → Context is a ONE-WAY projection; this module never writes to the graph.
 *
 * @see ADR 13 (Knapsack Slicing algorithm)
 * @see ADR 30 (Context Assembly Strategy)
 * @see CONTEXT.md §Knapsack Slicing
 */

import type { EventLogNode } from '@shared/types';
import { countTokens } from '@shared/tokenizer';
import { ZERO_HASH } from '@shared/constants';

/**
 * Minimal read-only graph interface required by knapsackSlice.
 * Consumers pass their own graph handle or mock; this avoids importing the
 * full GraphHandle (which carries write permissions, ADR 35 D-8).
 */
export interface KnapsackGraph {
  /** Return the EventLogNode whose version_hash equals `hash`, or undefined. */
  getEventByHash(hash: string): EventLogNode | undefined;
  /** Return sibling events (pending / conflict_detected) in the same scope. */
  getSiblings(scopeId: string, excludeHash: string): EventLogNode[];
}

/**
 * Knapsack Slicing algorithm.
 *
 * Vertical axis: walks `predecessor_hash` back to N_root (ZERO_HASH) to build
 *   the causal skeleton.
 * Horizontal axis: adds pending/conflict_detected sibling events in the same scope.
 * Budget: packs events newest-first until cumulative countTokens would exceed wMax.
 *
 * @param graph  Read-only graph accessor (no write permission required).
 * @param scopeId  The Scope being projected.
 * @param rootHash  The version_hash of the most-recent event (N_current).
 * @param wMax  Maximum token budget for the context slice.
 * @returns Events in reverse-chronological order (newest first), within budget.
 */
export async function knapsackSlice(
  graph: KnapsackGraph,
  scopeId: string,
  rootHash: string,
  wMax: number
): Promise<EventLogNode[]> {
  // --- Vertical axis: walk predecessor_hash chain to N_root ---
  const causalChain: EventLogNode[] = [];
  let currentHash = rootHash;

  while (currentHash && currentHash !== ZERO_HASH) {
    const event = graph.getEventByHash(currentHash);
    if (!event) break;
    causalChain.push(event);
    currentHash = event.predecessor_hash;
  }

  // causalChain is already newest-first (we walked from leaf to root)

  // --- Horizontal axis: add sibling events (pending / conflict_detected) ---
  const siblings = graph.getSiblings(scopeId, rootHash);
  const siblings_sorted = [...siblings].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime()
  );

  // Merge: causal chain first (higher priority), then siblings
  const candidates = [...causalChain, ...siblings_sorted];

  // --- Budget: greedy newest-first pack up to wMax ---
  const result: EventLogNode[] = [];
  let budget = wMax;

  for (const event of candidates) {
    const tokens = countTokens(event.payload);
    if (tokens > budget) {
      break;
    }
    result.push(event);
    budget -= tokens;
  }

  return result;
}
