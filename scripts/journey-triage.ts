/**
 * Live user journey for the freshness write-half (#32/#34) against the dev `graph`
 * DB (graph_test is busy with eval:loop). Seeds an ambiguous crystallization,
 * then drives the real gateway routes: triage list → feedback → retire →
 * reinstate, asserting the DB state transitions. Temporary verification script.
 */
process.env.VITEST = process.env.VITEST ?? '1';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const CS = process.env.JOURNEY_DB ?? 'postgres://postgres:password@localhost:5432/graph';

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: CS, max: 4 });
  const { buildApp } = await import('@graph/gateway/index.js');
  const app = buildApp(pool, pool, 4096);
  const id = randomUUID();
  const scopeSentinel = '00000000-0000-4000-8000-0000000ace01';

  const fail = (m: string): never => { throw new Error('JOURNEY FAIL: ' + m); };
  const get = async (p: string) => (await app.fetch(new Request('http://localhost' + p))).json() as Promise<Record<string, unknown>>;
  const post = async (p: string, body?: unknown) =>
    app.fetch(new Request('http://localhost' + p, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  const qcount = async (sql: string, params: unknown[]) =>
    Number((await pool.query<{ n: string }>(sql, params)).rows[0]!.n);

  try {
    // Ambiguous ingredient: quality 0.6, evidence 4 (< n_min 5 → thin → triage), used 4x.
    await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id = $1`, [scopeSentinel]);
    await pool.query(
      `INSERT INTO procedural_memory
         (id, scope_id, source_scope_id, content, intent_description, is_anti_pattern,
          success_count, failure_count, injection_count, last_used_at, created_at)
       VALUES ($1,$2,$2,$3,$4,FALSE,2,2,4,NOW(),NOW())`,
      [id, scopeSentinel, 'write_api before db_schema. security_scan before containerize.', 'Stand up a microservice'],
    );

    // 1. Triage inbox shows it, with success-rate.
    const triage = (await get('/v1/memory/triage')).triage as Array<{ id: string; quality_score: number }>;
    const found = triage.find((t) => t.id === id);
    if (!found) fail('seeded ambiguous template not surfaced in /memory/triage');
    console.log(`  ✓ triage surfaces ambiguous template (quality ${Number(found!.quality_score).toFixed(2)})`);

    // 2. Keep → success_count + 1.
    if ((await post(`/v1/memory/templates/${id}/feedback`, { outcome: 'success' })).status !== 200) fail('feedback !200');
    if ((await qcount(`SELECT success_count::text n FROM procedural_memory WHERE id=$1`, [id])) !== 3) fail('success_count not incremented');
    console.log('  ✓ keep → success_count 2→3 (clean human attribution)');

    // 3. Needs work → failure_count + 1.
    await post(`/v1/memory/templates/${id}/feedback`, { outcome: 'failure' });
    if ((await qcount(`SELECT failure_count::text n FROM procedural_memory WHERE id=$1`, [id])) !== 3) fail('failure_count not incremented');
    console.log('  ✓ needs-work → failure_count 2→3');

    // 4. Reject a numeric "outcome" (no typed numbers).
    if ((await post(`/v1/memory/templates/${id}/feedback`, { outcome: '5' })).status !== 400) fail('numeric outcome accepted');
    console.log('  ✓ numeric outcome rejected (400)');

    // 5. Retire → reversible logical-delete (superseded_by = id).
    if ((await post(`/v1/memory/templates/${id}/retire`)).status !== 200) fail('retire !200');
    if ((await qcount(`SELECT count(*)::text n FROM procedural_memory WHERE id=$1 AND superseded_by=id`, [id])) !== 1) fail('not self-superseded');
    console.log('  ✓ retire → superseded_by=id (reversible)');

    // 6. It leaves the triage inbox once retired.
    const after = (await get('/v1/memory/triage')).triage as Array<{ id: string }>;
    if (after.some((t) => t.id === id)) fail('retired template still in triage');
    console.log('  ✓ retired template no longer in triage');

    // 7. Human override reinstates it.
    if ((await post(`/v1/memory/templates/${id}/reinstate`)).status !== 200) fail('reinstate !200');
    if ((await qcount(`SELECT count(*)::text n FROM procedural_memory WHERE id=$1 AND superseded_by IS NULL`, [id])) !== 1) fail('not reinstated');
    console.log('  ✓ reinstate → superseded_by=NULL (human override, highest authority)');

    console.log('\nJOURNEY PASS — triage write-half end-to-end on live DB');
  } finally {
    await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id = $1`, [scopeSentinel]).catch(() => {});
    await pool.end();
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
