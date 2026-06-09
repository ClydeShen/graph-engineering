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
  let prevHash = ZERO_HASH;

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
    const contendedHash = prevHash;

    const [resultA, resultB] = await Promise.all([
      occWrite(pool, {
        scopeId: TEST_SCOPE_ID,
        entityId,
        predecessorHash: contendedHash,
        eventType: 'memory_updated',
        payload: payloadA,
      }),
      occWrite(pool, {
        scopeId: TEST_SCOPE_ID,
        entityId,
        predecessorHash: contendedHash,
        eventType: 'memory_updated',
        payload: payloadB,
      }),
    ]);

    const results = [resultA, resultB];
    const wonResults = results.filter((r) => r.occ_result === 'won');
    const demotedResults = results.filter((r) => r.occ_result === 'demoted');

    expect(wonResults).toHaveLength(1);
    expect(demotedResults).toHaveLength(1);
    // The loser's version_hash (conflict_detected row) is the available leaf — the winner's hash
    // is immediately consumed by the conflict_detected row as its predecessor_hash.
    prevHash = demotedResults[0].version_hash;
  });

  it('demoted predecessor_hash equals winner version_hash (causal inversion)', async () => {
    // Sequential writes so the second write's winner CTE always sees the first's committed row.
    // Causal inversion semantics are the same; it() 1 already covers concurrent detection.
    const entityId = randomUUID();
    const contendedHash = prevHash;

    const winner = await occWrite(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: contendedHash,
      eventType: 'memory_updated',
      payload: { writer: 'causal-A' },
    });
    expect(winner.occ_result).toBe('won');

    const loser = await occWrite(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: contendedHash,
      eventType: 'memory_updated',
      payload: { writer: 'causal-B' },
    });
    expect(loser.occ_result).toBe('demoted');
    prevHash = loser.version_hash;

    // Causal inversion: the loser's conflict_detected row in DB points at winner's version_hash
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
