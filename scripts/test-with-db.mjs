// Loads .env then runs `vitest run` with DATABASE_URL in scope.
// Use: node scripts/test-with-db.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

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
} catch { /* no .env */ }

const result = spawnSync('npx', ['vitest', 'run'], {
  stdio: 'inherit',
  env: process.env,
  shell: true,
});
process.exit(result.status ?? 0);
