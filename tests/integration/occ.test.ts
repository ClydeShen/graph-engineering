/**
 * occ.test.ts — REQ-02: concurrent OCC writes produce deterministic won/demoted result.
 *
 * Verifies:
 *  1. Two concurrent occWrite() calls against the same predecessor_hash:
 *     exactly one returns 'won' and one returns 'demoted'.
 *  2. The demoted row's predecessor_hash equals the winner's version_hash (causal inversion).
 *
 * Skips cleanly when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestPool, closeTestPool, skipIfNoDb } from '../helpers/pg-test-pool.js';
import { runMigrations } from '../../migrations/run-migrations.js';
import { occWrite } from '../../packages/shared/src/occ-write.js';
import { ZERO_HASH } from '../../packages/shared/src/constants.js';
import { randomUUID } from 'crypto';

const TEST_SCOPE_ID = randomUUID();
const TEST_SCOPE_NODASH = TEST_SCOPE_ID.replace(/-/g, '');

describe.skipIf(skipIfNoDb())('OCC causal inversion integration (REQ-02)', () => {
  const pool = getTestPool();

  beforeAll(async () => {
    await runMigrations(pool);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS execution_event_log_scope_${TEST_SCOPE_NODASH}
      PARTITION OF execution_event_log
      FOR VALUES IN ('${TEST_SCOPE_ID}')
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uk_occ_occ_${TEST_SCOPE_NODASH}'
        ) THEN
          ALTER TABLE execution_event_log_scope_${TEST_SCOPE_NODASH}
          ADD CONSTRAINT uk_occ_occ_${TEST_SCOPE_NODASH}
          UNIQUE (predecessor_hash, scope_id);
        END IF;
      END $$
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uk_idem_occ_${TEST_SCOPE_NODASH}'
        ) THEN
          ALTER TABLE execution_event_log_scope_${TEST_SCOPE_NODASH}
          ADD CONSTRAINT uk_idem_occ_${TEST_SCOPE_NODASH}
          UNIQUE (scope_id, entity_id, version_hash);
        END IF;
      END $$
    `);
  });

  afterAll(async () => {
    await pool.query(
      `DROP TABLE IF EXISTS execution_event_log_scope_${TEST_SCOPE_NODASH}`
    );
    await closeTestPool();
  });

  it('concurrent writes: exactly one won and one demoted', async () => {
    // Both writers use the SAME entity and predecessor_hash to create a contention
    const entityId = randomUUID();
    const payloadA = { writer: 'A', value: 1 };
    const payloadB = { writer: 'B', value: 2 };

    const [resultA, resultB] = await Promise.all([
      occWrite(pool, {
        scopeId: TEST_SCOPE_ID,
        entityId,
        predecessorHash: ZERO_HASH,
        eventType: 'memory_updated',
        payload: payloadA,
      }),
      occWrite(pool, {
        scopeId: TEST_SCOPE_ID,
        entityId,
        predecessorHash: ZERO_HASH,
        eventType: 'memory_updated',
        payload: payloadB,
      }),
    ]);

    const results = [resultA, resultB];
    const wonResults = results.filter((r) => r.occ_result === 'won');
    const demotedResults = results.filter((r) => r.occ_result === 'demoted');

    expect(wonResults).toHaveLength(1);
    expect(demotedResults).toHaveLength(1);
  });

  it('demoted predecessor_hash equals winner version_hash (causal inversion)', async () => {
    const entityId = randomUUID();
    const payloadA = { writer: 'causal-A', ts: Date.now() };
    const payloadB = { writer: 'causal-B', ts: Date.now() };

    const [resultA, resultB] = await Promise.all([
      occWrite(pool, {
        scopeId: TEST_SCOPE_ID,
        entityId,
        predecessorHash: ZERO_HASH,
        eventType: 'memory_updated',
        payload: payloadA,
      }),
      occWrite(pool, {
        scopeId: TEST_SCOPE_ID,
        entityId,
        predecessorHash: ZERO_HASH,
        eventType: 'memory_updated',
        payload: payloadB,
      }),
    ]);

    const winner = [resultA, resultB].find((r) => r.occ_result === 'won')!;
    const loser = [resultA, resultB].find((r) => r.occ_result === 'demoted')!;

    // Causal inversion: the loser's row in the DB should have its predecessor_hash
    // rewritten to point at the winner's version_hash
    const dbRow = await pool.query<{
      predecessor_hash: string;
      event_type: string;
    }>(
      `SELECT predecessor_hash, event_type
       FROM execution_event_log
       WHERE scope_id = $1 AND version_hash = $2`,
      [TEST_SCOPE_ID, loser.version_hash]
    );

    expect(dbRow.rows).toHaveLength(1);
    expect(dbRow.rows[0].event_type).toBe('conflict_detected');
    expect(dbRow.rows[0].predecessor_hash).toBe(winner.version_hash);
  });
});
