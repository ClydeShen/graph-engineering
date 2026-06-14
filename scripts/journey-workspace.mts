/**
 * Journey: workspace/project + LLM-overrides (Phase 21/22 remaining, GH #27/#28).
 * Exercises the NEW backend paths end-to-end against graph_test with NO LLM:
 *   1. scope project recording (recordScopeProject first-write-wins)
 *   2. GET /v1/forest groups roots by project + archived (lazy tombstone)
 *   3. GET /v1/artifacts inherits scope project + project_archived
 *   4. POST/GET /v1/sys/llm-overrides write path (fail-closed validation)
 * Self-cleaning: removes the rows it inserts.
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildForestRoute } from '../packages/gateway/src/routes/forest.ts';
import { buildArtifactsRoute } from '../packages/gateway/src/routes/artifacts.ts';
import { buildSysConfigRoute } from '../packages/gateway/src/routes/sys.ts';
import { recordScopeProject } from '../packages/shared/src/scope-project.ts';

const URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:password@localhost:5432/graph_test';
const pool = new Pool({ connectionString: URL });

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

const liveDir = mkdtempSync(join(tmpdir(), 'journey-live-'));
const goneDir = join(tmpdir(), `journey-gone-${randomUUID()}`); // never created → archived
const liveScope = randomUUID();
const goneScope = randomUUID();
const artHash = '0'.repeat(64);

try {
  // ── seed: two root scopes, one with a live project folder, one with a gone one
  await pool.query(
    `INSERT INTO scope_lineage (scope_id, parent_scope_id, depth, intent, status) VALUES ($1,NULL,0,$2,'active')`,
    [liveScope, 'session:console::journey'],
  );
  await pool.query(
    `INSERT INTO scope_lineage (scope_id, parent_scope_id, depth, intent, status) VALUES ($1,NULL,0,$2,'closed')`,
    [goneScope, 'session:telegram::journey'],
  );

  // 1. recordScopeProject — first-write-wins
  await recordScopeProject(pool, liveScope, liveDir);
  await recordScopeProject(pool, liveScope, '/other'); // must NOT overwrite
  await recordScopeProject(pool, goneScope, goneDir);
  const proj = await pool.query<{ project: string }>(`SELECT project FROM scope_lineage WHERE scope_id=$1`, [liveScope]);
  check('recordScopeProject sets the project', proj.rows[0]?.project === liveDir);
  check('recordScopeProject is first-write-wins', proj.rows[0]?.project !== '/other');

  // 2. forest groups by project + archived
  const forestApp = buildForestRoute(pool);
  const fres = await forestApp.request('/forest');
  const forest = (await fres.json()) as {
    projects: Array<{ project: string; name: string; roots: number; archived: boolean }>;
  };
  const live = forest.projects.find((p) => p.project === liveDir);
  const gone = forest.projects.find((p) => p.project === goneDir);
  check('forest exposes the live project cluster', !!live && live.archived === false);
  check('forest names the cluster by basename', live?.name === liveDir.split(/[\\/]/).pop());
  check('forest marks the gone project archived (lazy tombstone)', gone?.archived === true);

  // 3. artifacts inherit the scope project + project_archived
  await pool.query(
    `INSERT INTO artifact (content_hash, scope_id, entity_id, kind, media_type, byte_size, label)
     VALUES ($1,$2,$3,'markdown','text/markdown',3,'journey.md')
     ON CONFLICT (content_hash, scope_id) DO NOTHING`,
    [artHash, liveScope, randomUUID()],
  );
  const artApp = buildArtifactsRoute(pool);
  const ares = await artApp.request('/artifacts?limit=500');
  const arts = (await ares.json()) as Array<{ scope_id: string; project: string | null; project_archived: boolean }>;
  const mine = arts.find((a) => a.scope_id === liveScope);
  check('artifact inherits the scope project', mine?.project === liveDir);
  check('artifact project_archived false for a live folder', mine?.project_archived === false);

  // 4. llm-overrides write path — fail closed on bad input, accept good
  const sysApp = buildSysConfigRoute();
  const bad = await sysApp.request('/sys/llm-overrides', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  check('POST /sys/llm-overrides rejects empty body (400)', bad.status === 400);
  const badType = await sysApp.request('/sys/llm-overrides', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: { model: 5 } }) });
  check('POST /sys/llm-overrides rejects wrong type (400)', badType.status === 400);
  const cfg = await (await sysApp.request('/sys/config')).json() as { llm_overrides?: { present: boolean } };
  check('GET /sys/config carries llm_overrides projection', cfg.llm_overrides !== undefined);
} finally {
  // cleanup
  await pool.query(`DELETE FROM artifact WHERE scope_id = ANY($1)`, [[liveScope, goneScope]]).catch(() => {});
  await pool.query(`DELETE FROM scope_lineage WHERE scope_id = ANY($1)`, [[liveScope, goneScope]]).catch(() => {});
  rmSync(liveDir, { recursive: true, force: true });
  await pool.end();
}

console.log(`\nJourney: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
