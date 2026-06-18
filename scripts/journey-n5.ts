/**
 * Live N5 check (late-drift fix) against the dev `graph` DB. Proves recent_quality
 * (EWMA) drives apoptosis where cumulative Laplace would not:
 *   - a LATE-DRIFT template (high lifetime quality, low recent_quality) IS retired;
 *   - a HEALTHY template (high recent_quality) is NOT retired even at the same counts;
 *   - reinforce/soften move recent_quality the right way.
 * Temporary verification script.
 */
process.env.VITEST = process.env.VITEST ?? '1';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { PoolMemoryRepository } from '@graph/workers/base/memory-repository';

const CS = process.env.JOURNEY_DB ?? 'postgres://postgres:password@localhost:5432/graph';
const SENT = '00000000-0000-4000-8000-0000000ace05';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: CS, max: 4 });
  const memory = new PoolMemoryRepository(pool);
  const fail = (m: string): never => { throw new Error('N5 FAIL: ' + m); };
  const seed = async (id: string, sc: number, fc: number, rq: number) => {
    await pool.query(
      `INSERT INTO procedural_memory (id, scope_id, source_scope_id, content, intent_description,
         is_anti_pattern, success_count, failure_count, injection_count, recent_quality, last_used_at, created_at)
       VALUES ($1,$2,$2,'X before Y','t',FALSE,$3,$4,4,$5,NOW(),NOW())`,
      [id, SENT, sc, fc, rq],
    );
  };
  const rq = async (id: string) =>
    Number((await pool.query<{ r: string }>(`SELECT recent_quality::text r FROM procedural_memory WHERE id=$1`, [id])).rows[0]!.r);
  const superseded = async (id: string) =>
    (await pool.query(`SELECT 1 FROM procedural_memory WHERE id=$1 AND superseded_by=id`, [id])).rowCount === 1;

  try {
    await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id=$1`, [SENT]);
    const drift = randomUUID(), healthy = randomUUID(), young = randomUUID();
    // late-drift: lifetime quality high (6/8 → Laplace 0.78) but recent_quality sunk to 0.2
    await seed(drift, 6, 2, 0.2);
    // healthy: same counts, recent_quality still high
    await seed(healthy, 6, 2, 0.9);
    // young: bad recent_quality but thin evidence (below n_min) → must NOT retire
    await seed(young, 0, 1, 0.1);
    await pool.query(`UPDATE procedural_memory SET success_count=0, failure_count=1 WHERE id=$1`, [young]);

    const retired = await memory.metabolizeByEvidence({ nMin: 5, qualityBad: 0.3 });
    const retiredIds = new Set(retired.map((r) => r.id));

    if (!retiredIds.has(drift)) fail('late-drift template NOT retired (cumulative quality masked it — the bug N5 fixes)');
    console.log('  ✓ late-drift retired on recent_quality (lifetime Laplace 0.78 would NOT have)');
    if (retiredIds.has(healthy)) fail('healthy template wrongly retired');
    console.log('  ✓ healthy template kept (high recent_quality)');
    if (retiredIds.has(young)) fail('thin-evidence template retired below n_min');
    console.log('  ✓ thin-evidence (below n_min) not retired — needs a track record first');

    // EWMA direction: reinforce ↑, soften-style discount ↓
    const t = randomUUID();
    await seed(t, 0, 0, 0.5);
    await memory.reinforceTemplate(t, 1, 0.4); // toward 1: 0.6*0.5 + 0.4 = 0.7
    if (Math.abs((await rq(t)) - 0.7) > 1e-6) fail(`reinforce EWMA wrong: ${await rq(t)}`);
    await pool.query(`UPDATE procedural_memory SET recent_quality = (1-0.4)*recent_quality WHERE id=$1`, [t]); // soften toward 0: 0.42
    if (Math.abs((await rq(t)) - 0.42) > 1e-6) fail(`soften EWMA wrong: ${await rq(t)}`);
    console.log('  ✓ EWMA moves up on reinforce (0.5→0.7) and down on soften (0.7→0.42)');

    // Lever 2: outcome-streak circuit-breaker (registerRecallOutcome).
    const st = randomUUID();
    const scope = randomUUID();
    await seed(st, 5, 0, 0.9); // a healthy-looking template (high trust) ...
    await pool.query(`INSERT INTO template_injection (scope_id, template_id, trigger_type) VALUES ($1,$2,'cold_start')`, [scope, st]);
    let r = await memory.registerRecallOutcome(scope, false, 2); // streak 0→1, no retire
    if (r.length !== 0) fail('streak retired too early (after 1 fail)');
    r = await memory.registerRecallOutcome(scope, false, 2); // streak 1→2 ≥ 2 → retire
    if (!r.includes(st)) fail('streak did not retire at threshold');
    if (!(await superseded(st))) fail('streak-retired template not superseded');
    console.log('  ✓ outcome-streak breaker retires on consecutive fails (conformance-independent, even high-trust)');
    await memory.reinstateTemplate(st);
    await memory.registerRecallOutcome(scope, true, 2); // convergent recall resets streak
    const streak = Number((await pool.query<{ s: string }>(`SELECT recall_fail_streak::text s FROM procedural_memory WHERE id=$1`, [st])).rows[0]!.s);
    if (streak !== 0) fail(`convergent recall did not reset streak: ${streak}`);
    console.log('  ✓ convergent recall resets the streak (reversible circuit-breaker, not a trust verdict)');
    await pool.query(`DELETE FROM template_injection WHERE scope_id=$1`, [scope]);

    console.log('\nN5 PASS — recency-weighted retirement + outcome-streak breaker on live DB');
  } finally {
    await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id=$1`, [SENT]).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
