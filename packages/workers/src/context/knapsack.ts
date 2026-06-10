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
import type { KnapsackGraph } from '@shared/knapsack';

export type { KnapsackGraph };

/** Events kept within budget and events dropped beyond it. */
export interface KnapsackSliceResult {
  kept: EventLogNode[];
  dropped: EventLogNode[];
}

/**
 * Algorithm configuration for knapsackSlice.
 * Extensible: add new strategy values without changing call sites.
 * Phase 08 will add 'smart-crusher' (headroom SmartCrusher pattern).
 */
export interface KnapsackConfig {
  strategy?: 'newest-first';
}

/**
 * Knapsack Slicing algorithm.
 *
 * Vertical axis: walks `predecessor_hash` back to N_root (ZERO_HASH) to build
 *   the causal skeleton.
 * Horizontal axis: adds pending/conflict_detected sibling events in the same scope.
 * Budget: packs events newest-first until cumulative countTokens would exceed wMax.
 *
 * Returns both kept and dropped events. Dropped events are available for
 * Phase 08 CCR marker injection (headroom pattern — <<ccr:HASH>> sentinel).
 *
 * @param graph  Read-only graph accessor (no write permission required).
 * @param scopeId  The Scope being projected.
 * @param rootHash  The version_hash of the most-recent event (N_current).
 * @param wMax  Maximum token budget for the context slice.
 * @param config  Optional algorithm config. Default strategy: 'newest-first'.
 * @returns kept events (within budget) and dropped events (beyond budget).
 */
export async function knapsackSlice(
  graph: KnapsackGraph,
  scopeId: string,
  rootHash: string,
  wMax: number,
  _config?: KnapsackConfig
): Promise<KnapsackSliceResult> {
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
  const kept: EventLogNode[] = [];
  const dropped: EventLogNode[] = [];
  let budget = wMax;
  let budgetExhausted = false;

  for (const event of candidates) {
    if (budgetExhausted) {
      dropped.push(event);
      continue;
    }
    const tokens = countTokens(event.payload);
    if (tokens > budget) {
      budgetExhausted = true;
      dropped.push(event);
    } else {
      kept.push(event);
      budget -= tokens;
    }
  }

  return { kept, dropped };
}
