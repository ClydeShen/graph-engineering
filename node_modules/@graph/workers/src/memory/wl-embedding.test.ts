import { describe, it, expect } from 'vitest';
import { computeWLEmbedding } from './wl-embedding.js';

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
});
