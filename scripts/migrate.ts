import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

async function main() {
  // Load .env so this script works standalone (CI sets vars directly)
  try {
    const raw = readFileSync(join(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch { /* no .env — CI provides vars directly */ }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });

  // Wait up to 30 s for postgres to be ready
  for (let i = 0; i < 15; i++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch {
      if (i === 14) {
        console.error('postgres not ready after 30 s');
        process.exit(1);
      }
      console.log(`  waiting for postgres... (${i + 1}/15)`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  const dir = join(process.cwd(), 'migrations');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    try {
      await pool.query(sql);
      console.log(`  ✓ ${file}`);
    } catch (err) {
      console.error(`  ✗ ${file}:`, err);
      process.exit(1);
    }
  }

  await pool.end();
  console.log('migrations complete');
}

main().catch(err => { console.error(err); process.exit(1); });
