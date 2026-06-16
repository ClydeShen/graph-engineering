/**
 * Faithful agent loop (GH #24). Drives a microservice-DAG task to REAL
 * convergence: every step goes through the real MCP spawn_subtask ->
 * claim_next_task -> complete_task path, so complete_task's ADR-58 terminalizer
 * fires and checkConvergence reflects the true ledger. No shim terminalizer.
 *
 * Dependency gate: completing a step whose prerequisites are unmet is recorded
 * as a FAILED attempt (still terminalized — a concluded attempt) and does not
 * advance progress; the agent must do the prerequisites and retry. The injected
 * runbook (ON) lets the agent avoid the non-obvious-quirk failures an
 * uninjected agent (OFF) pays.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, LLMProvider } from '@graph/shared';
import { memReflect } from '@graph/workers/memory/reflect.function';
import { checkConvergence, writeScopeClosed } from '@graph/gateway/watchdog-sql';
import { STEPS, GOAL_TEXT, isReady, missingDeps, type Step } from './dag.js';

const W_MAX = 4096;
const TURN_CAP = 60;

export interface RunRecord {
  label: string;
  events: number;
  converged: boolean;
  goalAchieved: boolean;
  steps: number;
  gateFailures: number;
  failedSteps: string[];
  order: string[];
  recallHit: boolean;
  ms: number;
}

export interface AgentDeps {
  pool: Pool;
  embed: EmbeddingProvider | null;
  llm: LLMProvider;
  app: import('hono').Hono;
  skill: string;
}

async function mcp(app: import('hono').Hono, name: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await app.fetch(new Request('http://localhost/mcp/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

export async function createScope(app: import('hono').Hono, pool: Pool): Promise<{ scopeId: string; planHash: string }> {
  const res = await app.fetch(new Request('http://localhost/v1/scopes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'faithful-ab microservice' }),
  }));
  const { scope_id } = (await res.json()) as { scope_id: string };
  const { rows: [p] } = await pool.query<{ version_hash: string }>(
    `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 LIMIT 1`, [scope_id]);
  return { scopeId: scope_id, planHash: p!.version_hash };
}

type Action = { kind: 'step'; step: Step } | { kind: 'invalid' };

function parseAction(raw: string): Action {
  const m = raw.match(/\{[^{}]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { step?: string };
      if (o.step && (STEPS as readonly string[]).includes(o.step)) return { kind: 'step', step: o.step as Step };
    } catch { /* fall through */ }
  }
  return { kind: 'invalid' };
}

async function decideStep(
  llm: LLMProvider,
  ctx: { injected: string; completed: ReadonlySet<Step>; lastFailure: string | null },
): Promise<Action> {
  const remaining = STEPS.filter((s) => !ctx.completed.has(s));
  const system =
    'You are building a microservice by completing build steps one at a time. ' +
    'Respond with ONLY a JSON object naming the next step to attempt: {"step":"<name>"}. No prose.';
  const parts = [
    GOAL_TEXT,
    `Already completed: [${[...ctx.completed].join(', ') || 'none'}]`,
    `Remaining: [${remaining.join(', ')}]`,
  ];
  if (ctx.lastFailure) parts.push(`Last attempt: ${ctx.lastFailure}`);
  if (ctx.injected) parts.push(`Relevant runbook from past experience:\n${ctx.injected}`);
  const text = await llm.chat(
    [{ role: 'system', content: system }, { role: 'user', content: parts.join('\n\n') }],
    { temperature: 0 },
  );
  return parseAction(text);
}

async function countEvents(pool: Pool, scopeId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM execution_event_log WHERE scope_id = $1`, [scopeId]);
  return Number(rows[0]?.n ?? 0);
}

/** Run the task once to (attempted) convergence. Returns a detailed record. */
export async function runOnce(deps: AgentDeps, label: string, inject: boolean): Promise<{ rec: RunRecord; scopeId: string; head: string }> {
  const { pool, embed, llm, app, skill } = deps;
  const t0 = Date.now();
  const { scopeId, planHash } = await createScope(app, pool);

  const reflection = await memReflect(pool, embed, {
    query_text: GOAL_TEXT, trigger_type: 'cold_start', w_max: W_MAX, scope_id: scopeId, inject_procedural: inject,
  });
  const injected = reflection.content;
  const recallHit = inject && /containerize/i.test(injected) && /run_tests/i.test(injected);

  const completed = new Set<Step>();
  const order: string[] = [];
  const failedSteps: string[] = [];
  let lastFailure: string | null = null;
  let head = planHash;
  let turns = 0;

  while (completed.size < STEPS.length && turns < TURN_CAP) {
    turns++;
    const action = await decideStep(llm, { injected, completed, lastFailure });
    if (action.kind === 'invalid') { lastFailure = 'Could not parse. Reply exactly {"step":"<name>"}.'; continue; }
    const step = action.step;
    if (completed.has(step)) { lastFailure = `"${step}" is already done. Pick a remaining step.`; continue; }
    order.push(step);

    // Real MCP round trip: spawn -> claim -> complete (complete_task terminalizes
    // the task_spawned row via ADR-58).
    const spawn = await mcp(app, 'spawn_subtask', { scope_id: scopeId, predecessor_hash: head, required_skills: [skill], payload: { step } });
    const taskId = spawn['task_id'] as string;
    await mcp(app, 'claim_next_task', { skills: [skill], scope_id: scopeId });

    if (isReady(step, completed)) {
      await mcp(app, 'complete_task', { task_id: taskId, result: { step, status: 'completed' } });
      completed.add(step);
      lastFailure = null;
    } else {
      // gate failure — concluded as failed (still terminalized), no progress
      await mcp(app, 'complete_task', { task_id: taskId, result: { step, outcome: 'failed' } });
      failedSteps.push(step);
      lastFailure = `Step "${step}" FAILED: prerequisites not done yet (${missingDeps(step, completed).join(', ')}). Do those first.`;
    }
    // head advances to the task's latest row for the next spawn's predecessor
    const { rows: [h] } = await pool.query<{ version_hash: string }>(
      `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1`,
      [scopeId, taskId]);
    head = h!.version_hash;
  }

  const goalAchieved = completed.size === STEPS.length;
  let converged = false;
  if (goalAchieved) {
    // Real convergence decision; the harness triggers the scope_closed write the
    // control-plane watchdog would make in production (checkConvergence is real).
    if ((await checkConvergence(pool, scopeId)).isConverged) {
      await writeScopeClosed(pool, scopeId);
      converged = true;
    }
  }

  const rec: RunRecord = {
    label, events: await countEvents(pool, scopeId), converged, goalAchieved,
    steps: turns, gateFailures: failedSteps.length, failedSteps, order,
    recallHit, ms: Date.now() - t0,
  };
  return { rec, scopeId, head };
}

export async function cleanupScope(pool: Pool, scopeId: string): Promise<void> {
  const nodash = scopeId.replace(/-/g, '');
  await pool.query(`DROP TABLE IF EXISTS execution_event_log_scope_${nodash} CASCADE`).catch(() => {});
  await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [scopeId]).catch(() => {});
}

export async function registerSkill(app: import('hono').Hono): Promise<string> {
  const skill = `svc-${randomUUID().slice(0, 8)}`;
  await mcp(app, 'register_agent', { agent_card: { agent_id: randomUUID(), name: 'svc', description: 'svc', skills: [skill], protocol: 'mcp', version: '1.0' } });
  return skill;
}
