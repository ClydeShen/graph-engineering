import { describe, expect, it } from 'vitest';
import { diffTopology, nodeColor } from './topology-diff.js';
import type { TopologyResponse } from './api.js';

const node = (id: string, event_type = 'memory_updated') => ({ id, entity_id: `e-${id}`, event_type });
const topo = (nodes: string[], edges: Array<[string, string]>): TopologyResponse => ({
  nodes: nodes.map((n) => node(n)),
  edges: edges.map(([source, target]) => ({ source, target })),
  truncated: false,
});

describe('diffTopology', () => {
  it('first poll: everything is new', () => {
    const d = diffTopology(null, topo(['a', 'b'], [['a', 'b']]));
    expect(d.addedNodes).toHaveLength(2);
    expect(d.addedEdges).toHaveLength(1);
    expect(d.unchanged).toBe(false);
  });

  it('identical poll: unchanged short-circuit', () => {
    const t = topo(['a', 'b'], [['a', 'b']]);
    expect(diffTopology(t, t).unchanged).toBe(true);
  });

  it('incremental poll: only the new node/edge appear in the diff', () => {
    const prev = topo(['a', 'b'], [['a', 'b']]);
    const next = topo(['a', 'b', 'c'], [['a', 'b'], ['b', 'c']]);
    const d = diffTopology(prev, next);
    expect(d.addedNodes.map((n) => n.id)).toEqual(['c']);
    expect(d.addedEdges).toEqual([{ source: 'b', target: 'c' }]);
  });
});

describe('nodeColor', () => {
  it('maps known event types and falls back for unknown', () => {
    expect(nodeColor('task_spawned')).toBe('#4A9EFF');
    expect(nodeColor('context_oom_throttled')).toBe('#FF4D4F');
    expect(nodeColor('whatever')).toBe('#555555');
  });
});
