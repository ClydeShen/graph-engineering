/**
 * DDL-exclusive connection pool factory for the Control Plane Daemon.
 *
 * max: 2 — exclusive DDL connection, MUST NOT be shared with read queries.
 * Used only for: CREATE PARTITION, ALTER TABLE (constraints), CREATE INDEX,
 * and the 3-phase nesting protocol transaction.
 *
 * @see ADR 05 — Two separate DB pools: DDL exclusive + event read/LISTEN
 * @see ADR 22 — Credentials read at boot entry point only
 */
import pg from 'pg';

const { Pool } = pg;

export function createDdlPool(connectionString: string): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    console.error('[ddl-pool] Unexpected pool error:', err.message);
  });
  return pool;
}
