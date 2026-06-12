/**
 * Short-lived CLI database access — one pool per operation, always closed.
 * Resolution order: DATABASE_URL env, then the active profile's database.url.
 * Returns null when no database is configured (callers degrade gracefully —
 * config writes succeed, graph observation resumes when the DB is back).
 */

export async function withPool<T>(
  fn: (pool: import('pg').Pool) => Promise<T>,
): Promise<T | null> {
  let dbUrl = process.env['DATABASE_URL'];
  if (!dbUrl) {
    const { loadMemexConfig } = await import('@graph/shared');
    dbUrl = loadMemexConfig()?.database?.url;
  }
  if (!dbUrl) return null;
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}
