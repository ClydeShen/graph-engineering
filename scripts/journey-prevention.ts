/**
 * Live check for the prevention lever (topology-corroboration admission control).
 * With recallPromoteThreshold=1, memReflect must recall a PROMOTED template
 * (corroboration_count >= 1) and exclude an UNPROVEN one (corroboration_count = 0),
 * even though both match the query. Proves the recall gate filters as designed.
 * Temporary verification script. (Env set before import so FRESHNESS picks it up.)
 */
process.env.VITEST = process.env.VITEST ?? '1';
process.env.FRESHNESS_RECALL_PROMOTE_THRESHOLD = '1';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const CS = process.env.JOURNEY_DB ?? 'postgres://postgres:password@localhost:5432/graph';
const SENT = '00000000-0000-4000-8000-0000000ace07';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: CS, max: 4 });
  const { memReflect } = await import('@graph/workers/memory/reflect.function'); // imported AFTER env set
  const fail = (m: string): never => { throw new Error('PREVENTION FAIL: ' + m); };

  const seed = async (id: string, corr: number) =>
    pool.query(
      `INSERT INTO procedural_memory (id, scope_id, source_scope_id, content, intent_description,
         is_anti_pattern, success_count, failure_count, corroboration_count, last_used_at, created_at)
       VALUES ($1,$2,$2,$3,$3,FALSE,0,0,$4,NOW(),NOW())`,
      [id, SENT, 'deploy a microservice runbook: scaffold then build then deploy', corr],
    );

  try {
    await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id=$1`, [SENT]);
    const unproven = randomUUID(), promoted = randomUUID();
    await seed(unproven, 0); // fresh, never re-derived
    await seed(promoted, 1); // topology independently re-derived once

    // embed=null → degraded BM25 path (no embedding needed); both match the query text.
    const r = await memReflect(pool, null, {
      query_text: 'deploy a microservice runbook scaffold build deploy',
      trigger_type: 'cold_start', w_max: 4096, scope_id: randomUUID(), inject_procedural: true,
    });
    const ids = new Set(r.proceduralIds);
    if (ids.has(unproven)) fail('unproven template (corroboration 0) was recalled despite threshold=1');
    if (!ids.has(promoted)) fail('promoted template (corroboration 1) was NOT recalled');
    console.log('  ✓ recall gate: promoted (corroboration≥1) recalled, unproven (0) excluded');
    console.log(`  ✓ proceduralIds=${[...ids].length} (only the corroborated runbook loads the lottery)`);

    console.log('\nPREVENTION PASS — topology-corroboration admission control gates recall on live DB');
  } finally {
    await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id=$1`, [SENT]).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
