import { describe, it, expect } from 'vitest';
import { humanLabel, toGraph } from './forest-graph.js';
import type { LineageResponse } from './api.js';

describe('humanLabel', () => {
  it('parses a session intent into "platform · chat"', () => {
    expect(humanLabel('session:telegram::12345')).toBe('telegram · 12345');
  });

  it('truncates a long freeform intent to 24 chars', () => {
    expect(humanLabel('x'.repeat(40))).toBe('x'.repeat(24));
  });

  it('passes a short intent through unchanged', () => {
    expect(humanLabel('quick task')).toBe('quick task');
  });

  it('falls back to a noun for null intent', () => {
    expect(humanLabel(null)).toBe('task');
  });
});

describe('toGraph', () => {
  it('maps lineage nodes to graph nodes + parent→child links', () => {
    const lineage: LineageResponse = {
      root: 'r',
      nodes: [
        { scope_id: 'r', parent_scope_id: null, depth: 0, intent: 'session:slack::c1', status: 'active', created_at: 't0' },
        { scope_id: 'a', parent_scope_id: 'r', depth: 1, intent: null, status: 'closed', created_at: 't1' },
        { scope_id: 'b', parent_scope_id: 'r', depth: 1, intent: 'sub task', status: 'converged', created_at: 't2' },
      ],
    };
    const g = toGraph(lineage);
    expect(g.nodes).toHaveLength(3);
    expect(g.links).toEqual([
      { source: 'r', target: 'a' },
      { source: 'r', target: 'b' },
    ]);
    expect(g.nodes[0]!.label).toBe('slack · c1');
    expect(g.nodes[0]!.status).toBe('active');
  });

  it('a root-only lineage has no links', () => {
    const lineage: LineageResponse = {
      root: 'r',
      nodes: [{ scope_id: 'r', parent_scope_id: null, depth: 0, intent: null, status: 'active', created_at: 't0' }],
    };
    expect(toGraph(lineage).links).toEqual([]);
  });
});
