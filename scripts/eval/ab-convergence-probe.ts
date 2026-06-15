/**
 * F-1 convergence probe (GH #24). Empirically answers: does a scope that runs a
 * full spawn → claim → complete round trip ever satisfy the convergence SQL?
 *
 * Runs in-process against the worktree gateway + graph_test. Self-cleaning.
 *
 *   TEST_DB=postgres://...:graph_test npx tsx scripts/eval/ab-convergence-probe.ts
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const CONVERGENCE_SQL = `
  SELECT
    NOT EXISTS (
      SELECT 1 FROM execution_event_log
      WHERE scope_id = $1
        AND status NOT IN ('terminated', 'archived')
        AND event_type NOT IN ('scope_closed', 'conflict_detected')
    ) AS is_converged
`;

async function mcp(app: import('hono').Hono, id: number, name: string, args: unknown): Promise<unknown> {
  const res = await app.fetch(new Request('http://localhost/mcp/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}');
}

async function main(): Promise<void> {
  const cs = process.env.TEST_DB ?? 'postgres://postgres:password@localhost:5432/graph_test';
  const pool = new Pool({ connectionString: cs, max: 2 });
  const { buildApp } = await import('@graph/gateway/index.js');
  const app = buildApp(pool, pool, 4096);

  // 1. create scope
  const scopeRes = await app.fetch(new Request('http://localhost/v1/scopes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'ab-convergence-probe' }),
  }));
  const { scope_id } = (await scopeRes.json()) as { scope_id: string };
  const { rows: [planRow] } = await pool.query<{ version_hash: string }>(
    `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 LIMIT 1`, [scope_id]);
  const planHash = planRow!.version_hash;

  const report = async (label: string): Promise<void> => {
    const { rows } = await pool.query<{ is_converged: boolean }>(CONVERGENCE_SQL, [scope_id]);
    const { rows: evs } = await pool.query<{ event_type: string; status: string }>(
      `SELECT event_type, status FROM execution_event_log WHERE scope_id = $1 ORDER BY id`, [scope_id]);
    console.log(`\n[${label}] is_converged=${rows[0]!.is_converged}`);
    for (const e of evs) console.log(`   ${e.event_type.padEnd(16)} status=${e.status}`);
  };

  await report('after plan_created (no subtasks)');

  // 2. register agent + spawn + claim + complete
  const skill = `probe-${randomUUID().slice(0, 8)}`;
  const agentId = randomUUID();
  await mcp(app, 2, 'register_agent', { agent_card: { agent_id: agentId, name: 'probe', description: 'probe', skills: [skill], protocol: 'mcp', version: '1.0' } });
  const spawn = (await mcp(app, 3, 'spawn_subtask', { scope_id, predecessor_hash: planHash, required_skills: [skill], payload: { description: 'probe task' } })) as { task_id: string };
  await report('after spawn_subtask');
  await mcp(app, 4, 'claim_next_task', { skills: [skill], scope_id });
  await report('after claim_next_task');
  await mcp(app, 5, 'complete_task', { task_id: spawn.task_id, result: { output: 'done', status: 'done' } });
  await report('after complete_task');

  // cleanup
  const nodash = scope_id.replace(/-/g, '');
  await pool.query(`DROP TABLE IF EXISTS execution_event_log_scope_${nodash} CASCADE`).catch(() => {});
  await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [scope_id]).catch(() => {});
  await pool.query(`DELETE FROM agent_registry WHERE agent_id = $1`, [agentId]).catch(() => {});
  await pool.end();
  console.log('\nprobe complete (scope cleaned up)');
}

main().catch((e) => { console.error('probe error:', e instanceof Error ? e.message : e); process.exit(1); });
