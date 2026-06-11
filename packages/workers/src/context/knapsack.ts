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
 * Phase 08 added 'importance-stratified' (D-01): tiers candidates by event_type
 * before budget packing. Full SmartCrusher statistical change-point detection
 * (headroom pattern) was evaluated and rejected (D-11) in favor of this
 * event_type-based stratification.
 */
export interface KnapsackConfig {
  strategy?: 'newest-first' | 'importance-stratified';
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
  config?: KnapsackConfig
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

  // --- Importance stratification (D-01): re-order candidates before budget packing ---
  const packCandidates =
    config?.strategy === 'importance-stratified' ? stratifyByImportance(candidates) : candidates;

  // --- Budget: greedy newest-first pack up to wMax ---
  const kept: EventLogNode[] = [];
  const dropped: EventLogNode[] = [];
  let budget = wMax;
  let budgetExhausted = false;

  for (const event of packCandidates) {
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

/**
 * Importance stratification (D-01): re-orders candidates so higher-importance
 * events are tried first by the greedy budget loop, and collapses repetitive
 * memory_updated runs into a single representative entry.
 *
 * Tier 1 (highest, never dropped first): conflict_detected, scope_closed —
 *   hoisted to the front, in original relative order.
 * Tier 3 (aggregatable): consecutive memory_updated runs (length >= 2) in the
 *   remaining candidates collapse to their first (most recent) entry.
 * Tier 2: all other events, in original order, with collapsed Tier 3 entries
 *   interleaved in their original relative positions.
 *
 * `candidates` is assumed newest-first (causal chain + sibling order).
 */
function stratifyByImportance(candidates: EventLogNode[]): EventLogNode[] {
  const tier1: EventLogNode[] = [];
  const rest: EventLogNode[] = [];

  for (const event of candidates) {
    if (event.event_type === 'conflict_detected' || event.event_type === 'scope_closed') {
      tier1.push(event);
    } else {
      rest.push(event);
    }
  }

  // Tier 3: collapse consecutive memory_updated runs (length >= 2) to their first entry.
  const tier2WithTier3Collapsed: EventLogNode[] = [];
  for (let i = 0; i < rest.length; i++) {
    const event = rest[i]!;
    if (event.event_type !== 'memory_updated') {
      tier2WithTier3Collapsed.push(event);
      continue;
    }
    // Start of a memory_updated run — find its extent.
    let runEnd = i;
    while (runEnd + 1 < rest.length && rest[runEnd + 1]!.event_type === 'memory_updated') {
      runEnd++;
    }
    // Always keep the first (most recent) entry of the run, regardless of run length.
    tier2WithTier3Collapsed.push(event);
    i = runEnd;
  }

  return [...tier1, ...tier2WithTier3Collapsed];
}
