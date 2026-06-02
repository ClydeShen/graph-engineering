/**
 * Migration runner for graph-native agent runtime.
 *
 * Reads all *.sql files in the migrations/ directory in lexical order and
 * executes each against the database specified by DATABASE_URL.
 *
 * Usage:
 *   tsx migrations/run-migrations.ts          # direct execution
 *
 * Library usage:
 *   import { runMigrations } from './run-migrations.js';
 *   const pool = new Pool({ connectionString: process.env.DATABASE_URL });
 *   await runMigrations(pool);
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Executes all *.sql migration files in the migrations/ directory in lexical
 * (filename sort) order against the provided pg.Pool.
 *
 * Each file is executed as a single query — migration files must be idempotent
 * (using IF NOT EXISTS) so re-runs are safe.
 *
 * @param pool - A pg.Pool connected to the target database.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  const migrationsDir = __dirname;

  // Read all files in the migrations directory, filter to *.sql, sort lexically.
  const allFiles = await readdir(migrationsDir);
  const sqlFiles = allFiles
    .filter((f) => f.endsWith('.sql'))
    .sort(); // lexical sort: 001 < 002 < 003 etc.

  for (const filename of sqlFiles) {
    const filePath = join(migrationsDir, filename);
    const sql = await readFile(filePath, 'utf8');
    console.log(`[migrations] Running ${filename}...`);
    await pool.query(sql);
    console.log(`[migrations] ${filename} OK`);
  }
}

// Direct execution: `tsx migrations/run-migrations.ts`
// Reads DATABASE_URL from environment, creates pool, runs migrations, exits.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const connectionString =
    process.env['DATABASE_URL'] ??
    'postgres://postgres:postgres@localhost:5432/graph_test';

  const pool = new Pool({ connectionString });

  runMigrations(pool)
    .then(() => {
      console.log('[migrations] All migrations complete.');
      return pool.end();
    })
    .catch((err: unknown) => {
      console.error('[migrations] Migration failed:', err);
      process.exit(1);
    });
}
