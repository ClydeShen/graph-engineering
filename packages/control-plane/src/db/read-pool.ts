/**
 * Read pool for point-query reads and HWM tracking.
 * Separate from ddlPool — used for SELECT queries and bus_state updates.
 *
 * @see ADR 05 — Two separate DB pools: DDL exclusive + event read/LISTEN
 */
import pg from 'pg';

const { Pool } = pg;

export const readPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

readPool.on('error', (err) => {
  console.error('[read-pool] Unexpected pool error:', err.message);
});
