/**
 * Read pool factory for point-query reads and HWM tracking.
 * Separate from ddlPool — used for SELECT queries and bus_state updates.
 *
 * @see ADR 05 — Two separate DB pools: DDL exclusive + event read/LISTEN
 * @see ADR 22 — Credentials read at boot entry point only
 */
import pg from 'pg';

const { Pool } = pg;

export function createReadPool(connectionString: string): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    console.error('[read-pool] Unexpected pool error:', err.message);
  });
  return pool;
}
