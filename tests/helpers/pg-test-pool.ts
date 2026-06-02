/**
 * Shared PostgreSQL test pool fixture for integration test suites.
 *
 * Usage in integration tests:
 *   import { getTestPool, closeTestPool, skipIfNoDb } from '../helpers/pg-test-pool.js';
 *   describe.skipIf(skipIfNoDb())('my integration suite', () => { ... });
 *
 * No schema creation here — migrations own DDL (Plan 02).
 */

import { Pool } from 'pg';

let _pool: Pool | null = null;

/**
 * Returns a shared pg.Pool for integration tests.
 * Reads DATABASE_URL from environment; falls back to the local development default.
 * The pool is lazily initialized and cached for the test process lifetime.
 */
export function getTestPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString:
        process.env['DATABASE_URL'] ??
        'postgres://postgres:postgres@localhost:5432/graph_test',
    });
  }
  return _pool;
}

/**
 * Closes the shared pool. Call in afterAll() when tests are complete.
 */
export async function closeTestPool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

/**
 * Returns true when DATABASE_URL is not set in the environment.
 * Integration test suites use this with describe.skipIf() to gracefully skip
 * when a PostgreSQL database is not available.
 *
 * @example
 *   describe.skipIf(skipIfNoDb())('schema integration', () => { ... });
 */
export function skipIfNoDb(): boolean {
  return !process.env['DATABASE_URL'];
}
