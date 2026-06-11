/**
 * KnapsackGraph — read-only graph interface for Knapsack Slicing (ADR 13).
 *
 * Lives in @shared so both the Gateway (which builds the graph from SQL)
 * and the Workers (which read the graph for context assembly) depend on the
 * same neutral package rather than creating a transport→domain import.
 *
 * @see ADR 13 (Knapsack Slicing algorithm)
 * @see packages/workers/src/context/knapsack.ts (knapsackSlice implementation)
 * @see packages/gateway/src/knapsack-graph.ts (KnapsackGraph adapters)
 */

import type { EventLogNode } from './types.js';

/**
 * Minimal read-only graph interface required by knapsackSlice.
 *
 * Consumers (Gateway or Workers) pass their own adapter; this keeps
 * write permissions separate from the read-only context assembly path (ADR 35 D-8).
 */
export interface KnapsackGraph {
  /** Return the EventLogNode whose version_hash equals `hash`, or undefined. */
  getEventByHash(hash: string): EventLogNode | undefined;
  /** Return sibling events (pending_scheduling / pending_dispatch / conflict_detected) in the same scope, excluding excludeHash. */
  getSiblings(scopeId: string, excludeHash: string): EventLogNode[];
}
