/**
 * idempotency.test.ts — REQ-18: ON CONFLICT DO NOTHING for duplicate version_hash.
 *
 * Verifies:
 *  1. A second insert with identical (scope_id, entity_id, version_hash) affects 0 rows.
 *  2. Total row count stays 1 after the duplicate attempt.
 *
 * Skips cleanly when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestPool, closeTestPool, skipIfNoDb } from '../helpers/pg-test-pool.js';
import { runMigrations } from '../../migrations/run-migrations.js';
import { occWrite, occWriteIdempotent } from '../../packages/shared/src/occ-write.js';
import { ZERO_HASH } from '../../packages/shared/src/constants.js';
import { randomUUID } from 'crypto';

const TEST_SCOPE_ID = randomUUID();
const TEST_SCOPE_NODASH = TEST_SCOPE_ID.replace(/-/g, '');

describe.skipIf(skipIfNoDb())('idempotency — ON CONFLICT DO NOTHING (REQ-18)', () => {
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
          WHERE conname = 'uk_occ_id_${TEST_SCOPE_NODASH}'
        ) THEN
          ALTER TABLE execution_event_log_scope_${TEST_SCOPE_NODASH}
          ADD CONSTRAINT uk_occ_id_${TEST_SCOPE_NODASH}
          UNIQUE (predecessor_hash, scope_id);
        END IF;
      END $$
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uk_idem_id_${TEST_SCOPE_NODASH}'
        ) THEN
          ALTER TABLE execution_event_log_scope_${TEST_SCOPE_NODASH}
          ADD CONSTRAINT uk_idem_id_${TEST_SCOPE_NODASH}
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

  it('second insert with same version_hash affects 0 rows', async () => {
    const entityId = randomUUID();
    const payload = { idempotency: 'test', key: 'value' };

    // First write — inserts successfully
    const first = await occWriteIdempotent(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: ZERO_HASH,
      payload,
    });
    expect(first).not.toBeNull();
    expect(first!.occ_result).toBe('won');

    // Second write — same inputs produce the same version_hash; ON CONFLICT DO NOTHING
    const second = await occWriteIdempotent(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: ZERO_HASH,
      payload,
    });

    // occWriteIdempotent returns null when the insert was a no-op
    expect(second).toBeNull();
  });

  it('total row count stays 1 after duplicate attempt', async () => {
    const entityId = randomUUID();
    const payload = { idempotency: 'count-check', value: 99 };

    await occWriteIdempotent(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: ZERO_HASH,
      payload,
    });
    await occWriteIdempotent(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: ZERO_HASH,
      payload,
    });

    const countResult = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
       FROM execution_event_log
       WHERE scope_id = $1 AND entity_id = $2`,
      [TEST_SCOPE_ID, entityId]
    );

    expect(parseInt(countResult.rows[0].cnt, 10)).toBe(1);
  });

  it('DO NOTHING path: occWrite (causal) still overwrites; only DO NOTHING is idempotent', async () => {
    // Confirm that the primary OCC path (occWrite) does causal inversion on conflict,
    // while occWriteIdempotent silently drops duplicates.
    const entityId = randomUUID();
    const payload = { role: 'control' };

    const first = await occWrite(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: ZERO_HASH,
      eventType: 'memory_updated',
      payload,
    });
    expect(first.occ_result).toBe('won');

    // Writing a DIFFERENT payload with the same predecessor_hash via primary path
    // triggers causal inversion (demoted), not a silent no-op.
    const second = await occWrite(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: ZERO_HASH,
      eventType: 'memory_updated',
      payload: { role: 'challenger' },
    });
    expect(second.occ_result).toBe('demoted');
  });
});
