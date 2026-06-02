/**
 * DDL-exclusive connection pool for the Control Plane Daemon.
 *
 * max: 2 — exclusive DDL connection, MUST NOT be shared with read queries.
 * Used only for: CREATE PARTITION, ALTER TABLE (constraints), CREATE INDEX,
 * and the 3-phase nesting protocol transaction.
 *
 * @see ADR 05 — Two separate DB pools: DDL exclusive + event read/LISTEN
 */
import pg from 'pg';

const { Pool } = pg;

export const ddlPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

ddlPool.on('error', (err) => {
  console.error('[ddl-pool] Unexpected pool error:', err.message);
});
