import { describe, it, expect, vi } from 'vitest';
import {
  trailDiscoveryHitRate,
  lessonRetention,
  knapsackCompression,
  takeSnapshot,
  compareSnapshots,
  REGRESSION_TOLERANCE,
  type EvalSnapshot,
} from './eval-metrics.js';

function queryReturning(rowsBySubstring: Array<[string, Record<string, unknown>]>) {
  return vi.fn().mockImplementation((sql: string) => {
    const hit = rowsBySubstring.find(([s]) => sql.includes(s));
    return Promise.resolve({ rows: hit ? [hit[1]] : [] });
  });
}

describe('eval metrics (Phase 16 G3)', () => {
  it('hit rate = successes / injections from procedural_memory', async () => {
    const q = queryReturning([['procedural_memory', { injections: 20, successes: 13 }]]);
    const m = await trailDiscoveryHitRate((s, p) => q(s, p));
    expect(m).toEqual({ injections: 20, successes: 13, hitRate: 0.65 });
  });

  it('hit rate is null (no signal) when nothing was ever injected', async () => {
    const q = queryReturning([['procedural_memory', { injections: 0, successes: 0 }]]);
    const m = await trailDiscoveryHitRate((s, p) => q(s, p));
    expect(m.hitRate).toBeNull();
  });

  it('retention: surviving/total + reinforcement stats from procedural_memory (Lesson home)', async () => {
    const q = queryReturning([
      ['reinforcement_count', { total: 10, reinforced: 4, surviving: 8, avg_reinforcement: 1.5 }],
    ]);
    const m = await lessonRetention((s, p) => q(s, p));
    expect(m).toEqual({
      totalLessons: 10,
      reinforcedLessons: 4,
      retentionRatio: 0.8,
      avgReinforcement: 1.5,
    });
  });

  it('compression: kept ratio from a context assembly response (pure)', () => {
    const m = knapsackCompression({ context: [1, 2, 3], droppedCount: 7, ccrHashes: ['h'] });
    expect(m).toEqual({ contextEvents: 3, droppedCount: 7, ccrCount: 1, keptRatio: 0.3 });
    expect(knapsackCompression({ context: [], droppedCount: 0, ccrHashes: [] }).keptRatio).toBeNull();
  });

  it('takeSnapshot bundles all metrics with a timestamp', async () => {
    const q = queryReturning([
      ['injection_count > 0', { injections: 4, successes: 2 }],
      ['reinforcement_count', { total: 2, reinforced: 1, surviving: 2, avg_reinforcement: 0.5 }],
    ]);
    const snap = await takeSnapshot((s, p) => q(s, p), null, new Date('2026-06-12T00:00:00Z'));
    expect(snap.taken_at).toBe('2026-06-12T00:00:00.000Z');
    expect(snap.hit_rate.hitRate).toBe(0.5);
    expect(snap.retention.retentionRatio).toBe(1);
    expect(snap.compression).toBeNull();
  });

  describe('regression gate (ADR-49)', () => {
    const base: EvalSnapshot = {
      taken_at: 't0',
      hit_rate: { injections: 10, successes: 8, hitRate: 0.8 },
      retention: { totalLessons: 10, reinforcedLessons: 5, retentionRatio: 0.9, avgReinforcement: 1 },
      compression: { contextEvents: 8, droppedCount: 2, ccrCount: 0, keptRatio: 0.8 },
    };

    it('trips on a drop beyond tolerance, stays quiet within tolerance', () => {
      const within = structuredClone(base);
      within.hit_rate.hitRate = 0.8 - REGRESSION_TOLERANCE + 0.01;
      expect(compareSnapshots(base, within)).toEqual([]);

      const beyond = structuredClone(base);
      beyond.hit_rate.hitRate = 0.6;
      beyond.retention.retentionRatio = 0.7;
      const regressions = compareSnapshots(base, beyond);
      expect(regressions).toHaveLength(2);
      expect(regressions[0]).toContain('hit rate regressed');
    });

    it('null metrics (no signal yet) never trip the gate', () => {
      const sparse = structuredClone(base);
      sparse.hit_rate.hitRate = null;
      sparse.compression = null;
      expect(compareSnapshots(sparse, base)).toEqual([]); // null before
      expect(compareSnapshots(base, sparse)).toEqual([]); // null after
    });

    it('improvement never trips the gate', () => {
      const better = structuredClone(base);
      better.hit_rate.hitRate = 0.95;
      expect(compareSnapshots(base, better)).toEqual([]);
    });
  });
});
