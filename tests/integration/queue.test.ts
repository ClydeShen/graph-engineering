/**
 * Integration tests for PgQueueAdapter (REQ-17, REQ-18).
 *
 * Requires a running PostgreSQL instance via DATABASE_URL.
 * Skips cleanly when DATABASE_URL is not set (skipIfNoDb()).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { getTestPool, skipIfNoDb } from '../helpers/pg-test-pool.js';
import { runMigrations } from '../../migrations/run-migrations.js';
import { PgQueueAdapter } from '../../packages/workers/src/queue/pg-queue-adapter.js';

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let pool: Pool;
const TEST_SCOPE_ID = '00000000-0000-4000-8000-000000000q06';
const TEST_ENTITY_ID = '00000000-0000-4000-8000-000000000e06';

beforeAll(async () => {
  pool = getTestPool();
  await runMigrations(pool);

  // Create a scope partition for this test suite.
  // Use a stable UUID-like name to avoid collisions across test runs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS execution_event_log_q06_test
    PARTITION OF execution_event_log FOR VALUES IN ($1)
  `, [TEST_SCOPE_ID]);

  // Clean up any leftover rows from a previous run.
  await pool.query(
    'DELETE FROM execution_event_log WHERE scope_id = $1',
    [TEST_SCOPE_ID],
  );
});

afterAll(async () => {
  await pool.query(
    'DELETE FROM execution_event_log WHERE scope_id = $1',
    [TEST_SCOPE_ID],
  );
  await pool.end();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

let seqCounter = 0;

async function insertPendingEvent(seqNum?: number): Promise<number> {
  const seq = seqNum ?? ++seqCounter;
  const result = await pool.query<{ id: number }>(
    `INSERT INTO execution_event_log
      (scope_id, entity_id, event_type, payload, predecessor_hash,
       version_hash, status, base_priority, unlocks_count)
     VALUES ($1, $2, 'plan_created', $3, $4, $5, 'pending_dispatch', 1, 0)
     RETURNING id`,
    [
      TEST_SCOPE_ID,
      TEST_ENTITY_ID,
      JSON.stringify({ seq }),
      '0'.repeat(64),
      // Unique version_hash per row to avoid UK violation.
      Buffer.from(`q06-test-${seq}-${Date.now()}`).toString('hex').padEnd(64, '0').slice(0, 64),
    ],
  );
  return result.rows[0].id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(skipIfNoDb())('PgQueueAdapter integration', () => {
  it('two parallel nextEvent() calls return different event ids (SKIP LOCKED)', async () => {
    // Insert two pending_dispatch events.
    const id1 = await insertPendingEvent();
    const id2 = await insertPendingEvent();
    expect(id1).not.toBe(id2);

    const adapter1 = new PgQueueAdapter(pool);
    const adapter2 = new PgQueueAdapter(pool);

    // Claim concurrently — SKIP LOCKED must route them to different rows.
    const [event1, event2] = await Promise.all([
      adapter1.nextEvent(TEST_SCOPE_ID),
      adapter2.nextEvent(TEST_SCOPE_ID),
    ]);

    expect(event1).not.toBeNull();
    expect(event2).not.toBeNull();
    // Verify they claimed different rows.
    expect(event1!.id).not.toBe(event2!.id);
  });

  it('claimed event has status = processing', async () => {
    await insertPendingEvent();

    const adapter = new PgQueueAdapter(pool);
    const event = await adapter.nextEvent(TEST_SCOPE_ID);

    expect(event).not.toBeNull();

    const check = await pool.query<{ status: string }>(
      'SELECT status FROM execution_event_log WHERE id = $1',
      [event!.id],
    );
    expect(check.rows[0].status).toBe('processing');
  });

  it('nextEvent() returns null when queue is empty', async () => {
    // Drain all pending_dispatch rows for this scope.
    await pool.query(
      `UPDATE execution_event_log
       SET status = 'processing'
       WHERE status = 'pending_dispatch' AND scope_id = $1`,
      [TEST_SCOPE_ID],
    );

    const adapter = new PgQueueAdapter(pool);
    const event = await adapter.nextEvent(TEST_SCOPE_ID);
    expect(event).toBeNull();
  });

  it('backpressure: returns null immediately when activeWorkerCount >= MAX_PARALLELISM', async () => {
    await insertPendingEvent();

    const adapter = new PgQueueAdapter(pool);
    adapter.activeWorkerCount = 4; // all 4 slots occupied

    // Must short-circuit without touching the database.
    const event = await adapter.nextEvent(TEST_SCOPE_ID);
    expect(event).toBeNull();
  });

  it('idempotency: re-inserting same version_hash via ON CONFLICT DO NOTHING is a no-op (REQ-18)', async () => {
    const uniqueHash = 'b'.repeat(64);

    // First insert succeeds.
    const first = await pool.query(
      `INSERT INTO execution_event_log
        (scope_id, entity_id, event_type, payload, predecessor_hash,
         version_hash, status, base_priority, unlocks_count)
       VALUES ($1, $2, 'memory_updated', '{}', $3, $4, 'processing', 1, 0)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [TEST_SCOPE_ID, TEST_ENTITY_ID, '0'.repeat(64), uniqueHash],
    );

    // Second insert with same version_hash is a transparent no-op.
    const second = await pool.query(
      `INSERT INTO execution_event_log
        (scope_id, entity_id, event_type, payload, predecessor_hash,
         version_hash, status, base_priority, unlocks_count)
       VALUES ($1, $2, 'memory_updated', '{}', $3, $4, 'processing', 1, 0)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [TEST_SCOPE_ID, TEST_ENTITY_ID, '0'.repeat(64), uniqueHash],
    );

    expect(first.rowCount).toBe(1);
    expect(second.rowCount).toBe(0); // silent no-op — at-least-once re-delivery transparent
  });
});
