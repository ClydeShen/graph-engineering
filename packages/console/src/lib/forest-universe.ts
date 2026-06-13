/**
 * Pure universe-graph shaping for the Now hero (CONSOLE-REDESIGN §6.1, L0/L1):
 * /v1/forest → a two-tier graph of galaxy(channel) nodes and their root-task
 * nodes. No React/canvas deps — unit-testable. Clicking a task node drills into
 * its L2 tree (ForestCanvas).
 */

import type { ForestResponse } from './api.js';
import { humanLabel } from './forest-graph.js';

export interface UniverseNode {
  id: string;
  kind: 'galaxy' | 'task';
  label: string;
  status?: string;
  /** relative size: galaxy = task count; task = subtree size (descendants + 1). */
  size: number;
}

export interface UniverseData {
  nodes: UniverseNode[];
  links: Array<{ source: string; target: string }>;
}

export function galaxyId(channel: string): string {
  return `galaxy:${channel}`;
}

export function toUniverseGraph(forest: ForestResponse): UniverseData {
  const nodes: UniverseNode[] = [];
  const links: Array<{ source: string; target: string }> = [];
  for (const g of forest.galaxies) {
    const gid = galaxyId(g.channel);
    nodes.push({ id: gid, kind: 'galaxy', label: g.channel, size: Math.max(g.tasks.length, 1) });
    for (const t of g.tasks) {
      nodes.push({
        id: t.scope_id,
        kind: 'task',
        label: humanLabel(t.intent),
        status: t.status,
        size: t.descendants + 1,
      });
      links.push({ source: gid, target: t.scope_id });
    }
  }
  return { nodes, links };
}
