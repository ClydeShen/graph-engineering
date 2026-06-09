/**
 * hash-chain.test.ts — REQ-02: pgcrypto ↔ TypeScript canonical_json agreement.
 *
 * Verifies:
 *  1. occWrite() returns a version_hash matching /^[0-9a-f]{64}$/
 *  2. Re-computing canonical_json_text in TS + a separate DB digest() query yields
 *     the same hash (TS canonical_json ↔ pgcrypto round-trip agreement).
 *
 * Skips cleanly when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestPool, closeTestPool, skipIfNoDb } from '../helpers/pg-test-pool.js';
import { runMigrations } from '../../migrations/run-migrations.js';
import { occWrite } from '../../packages/shared/src/occ-write.js';
import { hashablePayload } from '../../packages/shared/src/canonical-json.js';
import { ZERO_HASH } from '../../packages/shared/src/constants.js';
import { randomUUID } from 'crypto';

// Unique scope UUID for this test run — isolated partition
const TEST_SCOPE_ID = randomUUID();
const TEST_SCOPE_NODASH = TEST_SCOPE_ID.replace(/-/g, '');

describe.skipIf(skipIfNoDb())('hash-chain integration (REQ-02)', () => {
  const pool = getTestPool();
  let prevHash = ZERO_HASH;

  beforeAll(async () => {
    await runMigrations(pool);

    // Create the scope partition sub-table with OCC constraints
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
          WHERE conname = 'uk_occ_hc_${TEST_SCOPE_NODASH}'
        ) THEN
          ALTER TABLE execution_event_log_scope_${TEST_SCOPE_NODASH}
          ADD CONSTRAINT uk_occ_hc_${TEST_SCOPE_NODASH}
          UNIQUE (predecessor_hash, scope_id);
        END IF;
      END $$
    `);
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uk_idem_hc_${TEST_SCOPE_NODASH}'
        ) THEN
          ALTER TABLE execution_event_log_scope_${TEST_SCOPE_NODASH}
          ADD CONSTRAINT uk_idem_hc_${TEST_SCOPE_NODASH}
          UNIQUE (scope_id, entity_id, version_hash);
        END IF;
      END $$
    `);
  });

  afterAll(async () => {
    // Drop test partition to clean up
    await pool.query(
      `DROP TABLE IF EXISTS execution_event_log_scope_${TEST_SCOPE_NODASH}`
    );
    await closeTestPool();
  });

  it('occWrite() returns a 64-char hex version_hash', async () => {
    const entityId = randomUUID();
    const result = await occWrite(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: prevHash,
      eventType: 'memory_updated',
      payload: { action: 'test', value: 42 },
    });

    expect(result.version_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.occ_result).toBe('won');
    prevHash = result.version_hash;
  });

  it('TS canonicalJson ↔ pgcrypto digest() produce identical hash', async () => {
    const entityId = randomUUID();
    const payload = { z_key: 'last', a_key: 'first', nested: { b: 2, a: 1 } };
    const predecessorForThisWrite = prevHash;

    // 1. Write via occWrite (hash computed by pgcrypto)
    const result = await occWrite(pool, {
      scopeId: TEST_SCOPE_ID,
      entityId,
      predecessorHash: predecessorForThisWrite,
      eventType: 'memory_updated',
      payload,
    });

    // 2. Re-compute the hash in PostgreSQL using the same inputs as the CTE
    const canonicalText = hashablePayload(payload);
    const dbResult = await pool.query<{ computed_hash: string }>(
      `SELECT encode(
        digest(
          $1::text || '|' || $2::text || '|' || $3::text || '|memory_updated|' || $4::text,
          'sha256'
        ),
        'hex'
      ) AS computed_hash`,
      [TEST_SCOPE_ID, entityId, predecessorForThisWrite, canonicalText]
    );

    const computedHash = dbResult.rows[0].computed_hash;
    expect(computedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.version_hash).toBe(computedHash);
    prevHash = result.version_hash;
  });
});
