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

/** UI-SPEC node color map (event_type → fill). */
export const NODE_COLOR_MAP: Record<string, string> = {
  task_spawned: '#4A9EFF',
  tool_invoked: '#7C5CFC',
  memory_updated: '#3DD68C',
  context_oom_throttled: '#FF4D4F',
  scope_closed: '#888888',
};

export const nodeColor = (eventType: string): string => NODE_COLOR_MAP[eventType] ?? '#555555';
