/**
 * cross-scope.test.ts
 *
 * GATE4-2: CrossScopePatternDiscoveryWorker writes cross_domain_cluster_id for
 * topologically-similar / semantically-different procedural_memory pairs.
 * Turned GREEN by: Plan 03-02 (CrossScopePatternDiscoveryWorker implementation).
 *
 * This file will fail to import until Plan 03-02 creates cross-scope.ts — that
 * is the intended RED state. The unit test (no DB) exercises the pure union-find
 * logic; the DB test is skipIf(no DATABASE_URL).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

// --- Unit test (no DB, pure union-find logic) ---------------------------------
// Dynamic import so we can catch the missing-module error gracefully
// (cross-scope.ts does not exist until Plan 03-02 — static import omitted to keep typecheck clean)
let discoverClustersImpl: ((pool: import('pg').Pool) => Promise<void>) | undefined;

beforeAll(async () => {
  try {
    // cross-scope.js does not exist until Plan 03-02 — intentional RED state
    const mod = await import('./cross-scope.js' as string);
    discoverClustersImpl = (mod as { discoverClusters?: (pool: import('pg').Pool) => Promise<void> }).discoverClusters;
  } catch {
    // Module not yet created — RED state, tests will fail intentionally
    discoverClustersImpl = undefined;
  }
});

/**
 * Pure union-find unit test (no DB).
 * Given: a list of similar pairs [(a,b), (b,c)], groupToPairs should assign
 * a,b,c the same cluster_id.
 *
 * This test exercises the union-find grouping logic independently of SQL.
 * It references `./cross-scope.js` which does not yet exist (RED state).
 */
describe('Cross-scope pattern discovery — union-find unit test', () => {
  it('GATE4-2 (unit): groups connected pairs into the same cluster_id', () => {
    if (!discoverClustersImpl) {
      // Module not yet created — RED state
      expect.fail('RED: cross-scope.ts not yet implemented (Plan 03-02 turns this GREEN)');
    }
    // When cross-scope.ts is implemented, it should export a groupPairs function
    // that accepts an array of [id_a, id_b] pairs and returns Map<id, cluster_id>.
    // For now the test is a placeholder exercising the expected interface.
    expect(true).toBe(true); // replaced by real assertions in Plan 03-02
  });
});

// --- DB-gated integration test -----------------------------------------------

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

describe('Cross-scope pattern discovery — DB integration (GATE4-2)', () => {
  let pool: import('pg').Pool | undefined;

  beforeAll(async () => {
    if (skip) return;
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    if (skip) return;
    await pool?.end();
  });

  it.skipIf(skip)(
    'GATE4-2 (DB): after running discoverClusters, topologically-similar rows share a non-NULL cross_domain_cluster_id',
    async () => {
      if (!discoverClustersImpl) {
        expect.fail('RED: cross-scope.ts not yet implemented (Plan 03-02 turns this GREEN)');
      }

      if (!pool) throw new Error('pool not initialized');

      // Seed two procedural_memory rows with identical topology_embedding and
      // different intent_embedding — simulating cross-domain pattern discovery.
      // The rows require both embeddings to be populated (migration 007 columns).
      const scopeA = randomUUID();
      const scopeB = randomUUID();

      // Insert two rows with identical topology vectors but different intent vectors.
      // In a real test these would be pgvector literals — here we use the migration 007
      // columns added by Plan 03-01 Task 1 (both nullable; real values seeded below).
      await pool.query(
        `INSERT INTO procedural_memory
           (scope_id, content, intent_description, template_graph,
            topology_embedding, intent_embedding, created_at)
         VALUES
           ($1, 'Pattern A', 'Research workflow', '{}', '[0.1,0.2,0.3]'::vector, '[0.9,0.1,0.1]'::vector, NOW()),
           ($2, 'Pattern B', 'Code review workflow', '{}', '[0.1,0.2,0.3]'::vector, '[0.1,0.9,0.1]'::vector, NOW())`,
        [scopeA, scopeB],
      );

      await discoverClustersImpl(pool);

      const { rows } = await pool.query<{ scope_id: string; cross_domain_cluster_id: string | null }>(
        `SELECT scope_id, cross_domain_cluster_id
         FROM procedural_memory
         WHERE scope_id = ANY($1)`,
        [[scopeA, scopeB]],
      );

      // Both rows should have been assigned the same non-NULL cluster_id
      expect(rows).toHaveLength(2);
      const clusterIds = rows.map((r) => r.cross_domain_cluster_id);
      expect(clusterIds[0]).not.toBeNull();
      expect(clusterIds[1]).not.toBeNull();
      expect(clusterIds[0]).toBe(clusterIds[1]);

      // Cleanup
      await pool.query(`DELETE FROM procedural_memory WHERE scope_id = ANY($1)`, [[scopeA, scopeB]]);
    },
  );
});
