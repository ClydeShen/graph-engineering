/**
 * template-graph.test.ts — TD-C / ADR-25 supplement 2.
 *
 * Phase 10 DoD G1: two isomorphic DAGs (different UUIDs, same topology) must
 * canonicalize to machine-identical JSON. Non-isomorphic graphs must not.
 */

import { describe, it, expect } from 'vitest';
import {
  buildTemplateGraphFromEvents,
  canonicalizeTemplateGraph,
  collapseLinearRuns,
  templateGraphsEquivalent,
  type TemplateGraph,
} from './template-graph.js';

function makeEvents(prefix: string, chain: string[]): {
  version_hash: string;
  predecessor_hash: string;
  event_type: string;
}[] {
  // linear chain: e0 <- e1 <- e2 ... with the given event_type sequence
  return chain.map((eventType, i) => ({
    version_hash: `${prefix}-${i}`,
    predecessor_hash: i === 0 ? 'ZERO' : `${prefix}-${i - 1}`,
    event_type: eventType,
  }));
}

describe('buildTemplateGraphFromEvents', () => {
  it('builds nodes per event and edges from in-scope predecessor links', () => {
    const g = buildTemplateGraphFromEvents(
      makeEvents('a', ['plan_created', 'task_spawned', 'memory_updated']),
    );
    // collapse keeps all three (labels differ)
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
    expect(g.abstraction).toBe('interface-edge');
  });

  it('ignores predecessor links pointing outside the scope (ZERO hash)', () => {
    const g = buildTemplateGraphFromEvents(makeEvents('a', ['plan_created']));
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });
});

describe('collapseLinearRuns', () => {
  it('collapses consecutive same-label linear runs into one node', () => {
    const g = buildTemplateGraphFromEvents(
      makeEvents('a', ['plan_created', 'memory_updated', 'memory_updated', 'memory_updated', 'scope_closed']),
    );
    // plan_created → memory_updated(×3 collapsed) → scope_closed
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
    const labels = g.nodes.map((n) => n.label).sort();
    expect(labels).toEqual(['memory_updated', 'plan_created', 'scope_closed']);
  });

  it('does not collapse same-label nodes on different branches', () => {
    // fan-out: root → m1, root → m2 (both memory_updated, NOT a linear run)
    const graph: TemplateGraph = {
      version: 1,
      abstraction: 'interface-edge',
      nodes: [
        { id: 'r', label: 'plan_created' },
        { id: 'm1', label: 'memory_updated' },
        { id: 'm2', label: 'memory_updated' },
      ],
      edges: [
        { from: 'r', to: 'm1' },
        { from: 'r', to: 'm2' },
      ],
    };
    const g = collapseLinearRuns(graph);
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(2);
  });
});

describe('canonicalizeTemplateGraph — Phase 10 DoD G1', () => {
  it('isomorphic DAGs with different UUIDs canonicalize to identical JSON', () => {
    const seq = ['plan_created', 'task_spawned', 'memory_updated', 'conflict_detected', 'memory_updated', 'scope_closed'];
    const a = buildTemplateGraphFromEvents(makeEvents('scopeA', seq));
    const b = buildTemplateGraphFromEvents(makeEvents('totally-different', seq));
    expect(JSON.stringify(canonicalizeTemplateGraph(a))).toBe(
      JSON.stringify(canonicalizeTemplateGraph(b)),
    );
  });

  it('isomorphic branched DAGs canonicalize identically regardless of input order', () => {
    const branched = (p: string, swap: boolean): TemplateGraph => {
      const nodes = [
        { id: `${p}-root`, label: 'plan_created' },
        { id: `${p}-t1`, label: 'task_spawned' },
        { id: `${p}-t2`, label: 'task_spawned' },
        { id: `${p}-m`, label: 'memory_updated' },
        { id: `${p}-c`, label: 'scope_closed' },
      ];
      const edges = [
        { from: `${p}-root`, to: `${p}-t1` },
        { from: `${p}-root`, to: `${p}-t2` },
        { from: `${p}-t1`, to: `${p}-m` },
        { from: `${p}-m`, to: `${p}-c` },
      ];
      return {
        version: 1,
        abstraction: 'interface-edge',
        nodes: swap ? [...nodes].reverse() : nodes,
        edges: swap ? [...edges].reverse() : edges,
      };
    };
    expect(templateGraphsEquivalent(branched('x', false), branched('y', true))).toBe(true);
  });

  it('non-isomorphic graphs are NOT equivalent', () => {
    const a = buildTemplateGraphFromEvents(
      makeEvents('a', ['plan_created', 'task_spawned', 'scope_closed']),
    );
    const b = buildTemplateGraphFromEvents(
      makeEvents('b', ['plan_created', 'conflict_detected', 'scope_closed']),
    );
    expect(templateGraphsEquivalent(a, b)).toBe(false);
  });

  it('canonical ids are n0..nK and edges are sorted', () => {
    const g = canonicalizeTemplateGraph(
      buildTemplateGraphFromEvents(makeEvents('a', ['plan_created', 'task_spawned', 'scope_closed'])),
    );
    expect(g.nodes.every((n) => /^n\d+$/.test(n.id))).toBe(true);
    const keys = g.edges.map((e) => `${e.from}>${e.to}`);
    expect([...keys].sort()).toEqual(keys);
  });

  it('preserves correlation_confidence through canonicalization', () => {
    const g: TemplateGraph = {
      version: 1,
      abstraction: 'interface-edge',
      nodes: [{ id: 'x', label: 'memory_updated' }],
      edges: [],
      correlation_confidence: 'low',
    };
    expect(canonicalizeTemplateGraph(g).correlation_confidence).toBe('low');
  });
});
