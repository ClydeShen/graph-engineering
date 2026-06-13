/**
 * Incremental topology diff (UI-SPEC Page 1): polling returns the full
 * adjacency list every 2s; only NEW nodes/edges get enter animations — the
 * existing graph is never redrawn.
 *
 * Pure data logic — unit-tested without G6 or a DOM.
 */

import type { TopologyEdge, TopologyNode, TopologyResponse } from './api.js';

export interface TopologyDiff {
  addedNodes: TopologyNode[];
  addedEdges: TopologyEdge[];
  /** Nothing changed — skip rendering entirely (tip-hash short-circuit). */
  unchanged: boolean;
}

const edgeKey = (e: TopologyEdge): string => `${e.source}→${e.target}`;

export function diffTopology(
  previous: TopologyResponse | null,
  next: TopologyResponse,
): TopologyDiff {
  if (previous === null) {
    return { addedNodes: next.nodes, addedEdges: next.edges, unchanged: next.nodes.length === 0 };
  }
  const knownNodes = new Set(previous.nodes.map((n) => n.id));
  const knownEdges = new Set(previous.edges.map(edgeKey));
  const addedNodes = next.nodes.filter((n) => !knownNodes.has(n.id));
  const addedEdges = next.edges.filter((e) => !knownEdges.has(edgeKey(e)));
  return { addedNodes, addedEdges, unchanged: addedNodes.length === 0 && addedEdges.length === 0 };
}

/** UI-SPEC node color map (event_type → fill), aligned to --node-* tokens. */
export const NODE_COLOR_MAP: Record<string, string> = {
  task_spawned: 'oklch(0.650 0.052 230)', // --node-task / glacier-500
  tool_invoked: 'oklch(0.585 0.062 332)', // --node-tool / mauve-500
  memory_updated: 'oklch(0.640 0.072 136)', // --node-memory / moss-500
  context_oom_throttled: 'oklch(0.595 0.135 40)', // --node-throttled / rust-500
  scope_closed: 'oklch(0.640 0.015 78)', // --node-closed / ink-400
};

export const nodeColor = (eventType: string): string => NODE_COLOR_MAP[eventType] ?? 'oklch(0.470 0.014 76)'; // ink-500
