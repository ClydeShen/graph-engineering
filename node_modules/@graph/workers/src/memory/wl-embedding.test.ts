/**
 * wl-embedding.test.ts
 *
 * GATE4-1 (this file): Two topologically equivalent scopes from different domains
 * have topology_embedding cosine similarity > 0.90.
 * Turned GREEN by: Plan 03-01 (Wave 0 — WL kernel already implemented).
 * If the cosine test FAILS, it reveals the WL kernel keys on raw node labels;
 * Plan 03-02 must address label-invariance before GATE4-1 can pass.
 */

import { describe, it, expect } from 'vitest';
import { computeWLEmbedding } from './wl-embedding.js';

/** Inline cosine similarity over two L2-normalized Float32Arrays. */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot; // already L2-normalized by computeWLEmbedding
}

describe('computeWLEmbedding', () => {
  it('returns Float32Array of length 128 for single node', () => {
    const result = computeWLEmbedding([{ id: 'a', event_type: 'task_spawned' }], []);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result).toHaveLength(128);
  });

  it('result is L2-normalized: sqrt(sum of squares) ≈ 1.0 for non-empty input', () => {
    const result = computeWLEmbedding([{ id: 'a', event_type: 'task_spawned' }], []);
    const norm = Math.sqrt(Array.from(result).reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1.0, 5);
  });

  it('is deterministic: same input twice produces identical output', () => {
    const nodes = [
      { id: 'a', event_type: 'task_spawned' },
      { id: 'b', event_type: 'memory_updated' },
    ];
    const edges = [{ source: 'a', target: 'b' }];
    const r1 = computeWLEmbedding(nodes, edges);
    const r2 = computeWLEmbedding(nodes, edges);
    expect(Array.from(r1)).toEqual(Array.from(r2));
  });

  it('empty nodes returns Float32Array(128) of all zeros', () => {
    const result = computeWLEmbedding([], []);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result).toHaveLength(128);
    expect(Array.from(result).every((v) => v === 0)).toBe(true);
  });

  it('edge connections affect embedding: graph with edge differs from nodes-only', () => {
    const nodes = [
      { id: 'a', event_type: 'task_spawned' },
      { id: 'b', event_type: 'memory_updated' },
    ];
    const withEdge = computeWLEmbedding(nodes, [{ source: 'a', target: 'b' }]);
    const withoutEdge = computeWLEmbedding(nodes, []);
    expect(Array.from(withEdge)).not.toEqual(Array.from(withoutEdge));
  });

  // ── GATE4-1: Topologically equivalent cross-domain graphs ────────────────────
  // Two graphs with identical structure but different node ID labels (simulating
  // the same workflow pattern appearing in two distinct domains: "research" vs "code-review").
  // Expected: cosine similarity > 0.90 — WL kernel should be label-invariant on structure.
  //
  // If this test FAILS: the kernel keys on raw node ID labels, not just event_type labels.
  // Plan 03-02 (CrossScopePatternDiscovery) must address label normalization before GATE4-1 passes.
  it('GATE4-1: two relabeled-isomorphic graphs (same topology, different node IDs) have cosine similarity > 0.90', () => {
    // Domain A — "research" task: explore → hypothesize → validate → converge
    const nodesA = [
      { id: 'research-001', event_type: 'task_spawned' },
      { id: 'research-002', event_type: 'memory_updated' },
      { id: 'research-003', event_type: 'memory_updated' },
      { id: 'research-004', event_type: 'scope_closed' },
    ];
    const edgesA = [
      { source: 'research-001', target: 'research-002' },
      { source: 'research-002', target: 'research-003' },
      { source: 'research-003', target: 'research-004' },
    ];

    // Domain B — "code-review" task: same topological structure, different node IDs
    const nodesB = [
      { id: 'review-x1', event_type: 'task_spawned' },
      { id: 'review-x2', event_type: 'memory_updated' },
      { id: 'review-x3', event_type: 'memory_updated' },
      { id: 'review-x4', event_type: 'scope_closed' },
    ];
    const edgesB = [
      { source: 'review-x1', target: 'review-x2' },
      { source: 'review-x2', target: 'review-x3' },
      { source: 'review-x3', target: 'review-x4' },
    ];

    const embA = computeWLEmbedding(nodesA, edgesA);
    const embB = computeWLEmbedding(nodesB, edgesB);

    const sim = cosineSim(embA, embB);
    // GATE4-1 threshold: topology cosine similarity > 0.90
    expect(sim).toBeGreaterThan(0.90);
  });
});
