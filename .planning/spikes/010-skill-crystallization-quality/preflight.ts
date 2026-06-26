/**
 * Spike 010 — live-batch preflight: is the env READY to start the live validation?
 * Checks the three preconditions in LIVE-BATCH.md §0 without running the LLM loop.
 *
 *   npx tsx .planning/spikes/010-skill-crystallization-quality/preflight.ts
 *
 * Exits 0 = READY, 1 = NOT READY (prints exactly what is missing). Safe to run now —
 * with no DB/keys it honestly reports the gaps.
 */
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// Load .env into process.env so the embedding probe + key check see real values
// (the config's ${ENV_VAR} interpolation and profile.envVar both read process.env).
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[k] === undefined) process.env[k] = v;
  }
} catch { /* .env optional */ }

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];

// 1. LLM keys present in .env (or already exported)
{
  let found: string[] = [];
  const keyRe = /^(LLM_[A-Z_]+|[A-Z0-9_]*API_KEY|[A-Z0-9_]*BASE_URL)\s*=\s*(.+)$/;
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = keyRe.exec(line);
      if (m && m[2].trim() !== '') found.push(m[1]);
    }
  } catch { /* .env optional */ }
  const exported = Object.keys(process.env).filter((k) => /(_API_KEY|_BASE_URL)$|^LLM_/.test(k));
  const all = [...new Set([...found, ...exported])];
  checks.push({
    name: 'LLM keys (.env or env)',
    pass: all.length > 0,
    detail: all.length > 0 ? `found: ${all.join(', ')}` : 'none — add LLM_*/API_KEY/BASE_URL to .env',
  });
}

// 2b. Embedding endpoint reachable — recall degrades to BM25-only without it, and the
//     loop then does NOT learn (run.ts:47 probes embed('probe') and nulls on failure).
async function embeddingCheck(): Promise<void> {
  try {
    const shared = await import('@graph/shared');
    const cfg = shared.mergeLlmOverrides(shared.loadMemexConfig(), shared.readLlmOverrides());
    const embed = shared.buildEmbeddingProvider(cfg);
    if (!embed) {
      checks.push({ name: 'embedding endpoint reachable (recall)', pass: false, detail: 'no embedding provider — set EMBEDDING_MODEL + a reachable /embeddings endpoint' });
      return;
    }
    await embed.embed('probe');
    checks.push({ name: 'embedding endpoint reachable (recall)', pass: true, detail: 'probe ok' });
  } catch (e) {
    checks.push({ name: 'embedding endpoint reachable (recall)', pass: false, detail: `probe failed (${String((e as Error).message).slice(0, 90)}) — degraded BM25, loop will NOT learn` });
  }
}

// 2 + 3. Postgres reachable + migrations applied (execution_event_log present)
async function dbChecks(): Promise<void> {
  const conn = process.env.TEST_DB ?? 'postgres://postgres:password@localhost:5432/graph_test';
  const pool = new Pool({ connectionString: conn, connectionTimeoutMillis: 3000, max: 1 });
  try {
    await pool.query('SELECT 1');
    checks.push({ name: 'PostgreSQL reachable (TEST_DB)', pass: true, detail: conn.replace(/:[^:@/]*@/, ':***@') });
    const r = await pool.query("SELECT to_regclass('public.execution_event_log') AS t");
    const present = r.rows[0]?.t !== null;
    checks.push({
      name: 'migrations applied (execution_event_log)',
      pass: present,
      detail: present ? 'present' : 'missing — run migrations against graph_test',
    });
  } catch (e) {
    checks.push({ name: 'PostgreSQL reachable (TEST_DB)', pass: false, detail: `cannot connect: ${(e as Error).message}` });
    checks.push({ name: 'migrations applied (execution_event_log)', pass: false, detail: 'skipped (no DB)' });
  } finally {
    await pool.end().catch(() => {});
  }
}

async function main(): Promise<void> {
  await dbChecks();
  await embeddingCheck();
  console.log('\n── live-batch preflight ──');
  for (const c of checks) console.log(`  ${c.pass ? 'READY ' : 'BLOCK '} ${c.name.padEnd(38)} ${c.detail}`);
  const ready = checks.every((c) => c.pass);
  console.log(`\n${ready ? 'READY — preconditions met. Start at LIVE-BATCH.md §1.' : 'NOT READY — resolve the BLOCK rows above (see LIVE-BATCH.md §0).'}`);
  console.log('Note: this does not run the LLM loop; after READY, also confirm `npm run eval:loop` is green.\n');
  process.exit(ready ? 0 : 1);
}

main();
