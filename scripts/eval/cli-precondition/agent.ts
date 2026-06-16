/**
 * B2 faithful agent loop (GH #24). Same real plumbing as the §5 harness — every
 * action goes through the real MCP spawn_subtask -> claim_next_task -> complete_task
 * path, so ADR-58 terminalization fires and checkConvergence reflects the true
 * ledger — but success is decided by REALLY RUNNING the action's command
 * (dag.runAction), not by a synthetic readiness table. use_skill fails with a real
 * "command not found" until install_cli has run. The agent must learn to install
 * first; the recalled lesson (warm runs) is what lets it skip the discovery failure.
 */
import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { EmbeddingProvider, LLMProvider } from '@graph/shared';
import { memReflect } from '@graph/workers/memory/reflect.function';
import { checkConvergence, writeScopeClosed } from '@graph/gateway/watchdog-sql';
import { ACTIONS, GOAL_TEXT, SKILL_STUB, runAction, isCliInstalled, type Action } from './dag.js';

const W_MAX = 4096;
const TURN_CAP = 12;

export interface RunRecord {
  label: string;
  events: number;
  converged: boolean;
  goalAchieved: boolean;
  turns: number;
  discoveryFailures: number; // use_skill attempts that hit "command not found"
  installedFirst: boolean; // did the agent install before its first use attempt?
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

async function createScope(app: import('hono').Hono, pool: Pool): Promise<{ scopeId: string; planHash: string }> {
  const res = await app.fetch(new Request('http://localhost/v1/scopes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'cli-precondition' }),
  }));
  const { scope_id } = (await res.json()) as { scope_id: string };
  const { rows: [p] } = await pool.query<{ version_hash: string }>(
    `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 LIMIT 1`, [scope_id]);
  return { scopeId: scope_id, planHash: p!.version_hash };
}

function parseAction(raw: string): Action | null {
  const m = raw.match(/\{[^{}]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]) as { action?: string };
      if (o.action && (ACTIONS as readonly string[]).includes(o.action)) return o.action as Action;
    } catch { /* fall through */ }
  }
  return null;
}

async function decideAction(
  llm: LLMProvider,
  ctx: { injected: string; done: ReadonlySet<Action>; lastFailure: string | null },
): Promise<Action | null> {
  const system =
    'You accomplish a task with a command-line tool, one action at a time. ' +
    'Respond with ONLY a JSON object naming the next action: {"action":"<name>"}. No prose.';
  const parts = [
    GOAL_TEXT,
    `Skill documentation:\n${SKILL_STUB}`,
    `Actions taken: [${[...ctx.done].join(', ') || 'none'}]`,
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

/** Run the task once to (attempted) convergence. The CLI must be reset to absent by the caller first. */
export async function runOnce(deps: AgentDeps, label: string, inject: boolean): Promise<{ rec: RunRecord; scopeId: string; head: string }> {
  const { pool, embed, llm, app, skill } = deps;
  const t0 = Date.now();
  const { scopeId, planHash } = await createScope(app, pool);

  const reflection = await memReflect(pool, embed, {
    query_text: GOAL_TEXT, trigger_type: 'cold_start', w_max: W_MAX, scope_id: scopeId, inject_procedural: inject,
  });
  const injected = reflection.content;
  // The recalled lesson "hits" when it carries the precondition (install before use).
  const recallHit = inject && /install/i.test(injected) && /(before|first)/i.test(injected);

  const done = new Set<Action>();
  const order: string[] = [];
  let lastFailure: string | null = null;
  let head = planHash;
  let turns = 0;
  let discoveryFailures = 0;
  let goalAchieved = false;
  let firstUseSeen = false;
  let installedFirst = false;

  while (!goalAchieved && turns < TURN_CAP) {
    turns++;
    const action = await decideAction(llm, { injected, done, lastFailure });
    if (action === null) { lastFailure = 'Could not parse. Reply exactly {"action":"install_cli"} or {"action":"use_skill"}.'; continue; }
    order.push(action);
    if (action === 'use_skill' && !firstUseSeen) {
      firstUseSeen = true;
      installedFirst = isCliInstalled(); // did install precede the first use attempt?
    }

    // Real MCP round trip; success decided by REALLY running the action's command.
    const spawn = await mcp(app, 'spawn_subtask', { scope_id: scopeId, predecessor_hash: head, required_skills: [skill], payload: { step: action } });
    const taskId = spawn['task_id'] as string;
    await mcp(app, 'claim_next_task', { skills: [skill], scope_id: scopeId });

    const result = runAction(action);
    if (result.ok) {
      await mcp(app, 'complete_task', { task_id: taskId, result: { step: action, status: 'completed' } });
      done.add(action);
      lastFailure = null;
      if (action === 'use_skill') goalAchieved = true; // the report ran → job done
    } else {
      await mcp(app, 'complete_task', { task_id: taskId, result: { step: action, outcome: 'failed' } });
      if (action === 'use_skill') discoveryFailures++;
      lastFailure = `Action "${action}" FAILED: ${result.detail}`;
    }
    const { rows: [h] } = await pool.query<{ version_hash: string }>(
      `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 AND entity_id = $2 ORDER BY id DESC LIMIT 1`,
      [scopeId, taskId]);
    head = h!.version_hash;
  }

  let converged = false;
  if (goalAchieved && (await checkConvergence(pool, scopeId)).isConverged) {
    await writeScopeClosed(pool, scopeId);
    converged = true;
  }

  const rec: RunRecord = {
    label, events: await countEvents(pool, scopeId), converged, goalAchieved,
    turns, discoveryFailures, installedFirst, order, recallHit, ms: Date.now() - t0,
  };
  return { rec, scopeId, head };
}

export async function cleanupScope(pool: Pool, scopeId: string): Promise<void> {
  const nodash = scopeId.replace(/-/g, '');
  await pool.query(`DROP TABLE IF EXISTS execution_event_log_scope_${nodash} CASCADE`).catch(() => {});
  await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [scopeId]).catch(() => {});
}

export async function registerSkill(app: import('hono').Hono): Promise<string> {
  const skill = `data-${randomUUID().slice(0, 8)}`;
  await mcp(app, 'register_agent', { agent_card: { agent_id: randomUUID(), name: 'data', description: 'data', skills: [skill], protocol: 'mcp', version: '1.0' } });
  return skill;
}
