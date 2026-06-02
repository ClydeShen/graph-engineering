/**
 * Schema integration tests — verifies that migrations create the expected
 * PostgreSQL schema structure.
 *
 * Requires a running PostgreSQL instance with DATABASE_URL set.
 * When DATABASE_URL is not set, the suite is skipped (not failed).
 *
 * Run: npm run test:integration -- schema
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestPool, closeTestPool, skipIfNoDb } from '../helpers/pg-test-pool.js';
import { runMigrations } from '../../migrations/run-migrations.js';

describe.skipIf(skipIfNoDb())('schema integration', () => {
  beforeAll(async () => {
    const pool = getTestPool();
    await runMigrations(pool);
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('execution_event_log exists and is a partitioned table (relkind = p)', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ relkind: string }>(
      `SELECT relkind
       FROM pg_class
       WHERE relname = 'execution_event_log'
         AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')`,
    );
    expect(result.rows).toHaveLength(1);
    // relkind 'p' = partitioned table in PostgreSQL
    expect(result.rows[0]!.relkind).toBe('p');
  });

  it('execution_event_log.payload column data_type is text (not jsonb)', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ data_type: string }>(
      `SELECT data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_event_log'
         AND column_name = 'payload'`,
    );
    expect(result.rows).toHaveLength(1);
    // ADR 02: payload MUST be TEXT, never JSONB
    expect(result.rows[0]!.data_type).toBe('text');
  });

  it('episodic_memory table exists', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'episodic_memory'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('semantic_memory table exists', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'semantic_memory'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('procedural_memory table exists', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'procedural_memory'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('working_memory table exists', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'working_memory'`,
    );
    expect(result.rows).toHaveLength(1);
  });

  it('procedural_memory has an HNSW index (topology_embedding)', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ indexdef: string }>(
      `SELECT indexdef
       FROM pg_indexes
       WHERE tablename = 'procedural_memory'
         AND schemaname = 'public'`,
    );
    const hasHnsw = result.rows.some((row) =>
      row.indexdef.toLowerCase().includes('hnsw'),
    );
    expect(hasHnsw).toBe(true);
  });

  it('bus_state table has last_processed_event_id column', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'bus_state'
         AND column_name = 'last_processed_event_id'`,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.data_type).toBe('bigint');
  });

  it('scope_lineage table has parent_scope_id and depth columns', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'scope_lineage'
         AND column_name IN ('parent_scope_id', 'depth')
       ORDER BY column_name`,
    );
    const colNames = result.rows.map((r) => r.column_name);
    expect(colNames).toContain('depth');
    expect(colNames).toContain('parent_scope_id');
  });

  it('execution_event_log has all typed frontier columns', async () => {
    const pool = getTestPool();
    const result = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'execution_event_log'
         AND column_name IN ('base_priority', 'unlocks_count', 'spawned_by', 'last_active_at')
       ORDER BY column_name`,
    );
    const colNames = result.rows.map((r) => r.column_name);
    expect(colNames).toContain('base_priority');
    expect(colNames).toContain('unlocks_count');
    expect(colNames).toContain('spawned_by');
    expect(colNames).toContain('last_active_at');
  });
});
