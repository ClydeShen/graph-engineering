/**
 * Pure graph-shaping for ForestCanvas — no React / canvas / next deps, so it is
 * unit-testable without a DOM or the next/dynamic runtime. ForestCanvas imports
 * these; tests target this module directly. (CONSOLE-REDESIGN §6.)
 */

import type { LineageResponse } from './api.js';

export interface GraphNode {
  id: string;
  label: string;
  status: string;
  depth: number;
}

export interface GraphData {
  nodes: GraphNode[];
  links: Array<{ source: string; target: string }>;
}

/** Human label: strip the session: prefix, else the raw intent, else a noun. */
export function humanLabel(intent: string | null): string {
  if (!intent) return 'task';
  const m = /^session:([a-z]+)::(.+)$/i.exec(intent);
  if (m) return `${m[1]} · ${m[2]!.slice(0, 16)}`;
  return intent.slice(0, 24);
}

/** scope_lineage subtree → react-force-graph {nodes, links}. */
export function toGraph(lineage: LineageResponse): GraphData {
  const nodes = lineage.nodes.map((n) => ({
    id: n.scope_id,
    label: humanLabel(n.intent),
    status: n.status,
    depth: n.depth,
  }));
  const links = lineage.nodes
    .filter((n) => n.parent_scope_id !== null)
    .map((n) => ({ source: n.parent_scope_id as string, target: n.scope_id }));
  return { nodes, links };
}
