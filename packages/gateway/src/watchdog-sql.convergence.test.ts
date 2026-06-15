/**
 * ADR-58 convergence terminalizer — DB-backed integration test.
 *
 * Asserts the two halves of the new convergence semantic:
 *   1. a task scope converges once its spawned task is completed (complete_task
 *      terminalizes the task_spawned row → checkConvergence flips true)
 *   2. a chat-style scope (memory_updated only, no task_spawned) never converges
 *      (EXISTS(task_spawned) guard protects ADR-54 conversations)
 *
 * Requires DATABASE_URL (vitest points it at graph_test). Skips when absent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { checkConvergence } from './watchdog-sql.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

async function mcp(app: import('hono').Hono, id: number, name: string, args: unknown): Promise<Record<string, unknown>> {
  const res = await app.fetch(new Request('http://localhost/mcp/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  }));
  const body = (await res.json()) as { result?: { content?: Array<{ text: string }> } };
  return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('ADR-58 convergence terminalizer', () => {
  let pool: import('pg').Pool | undefined;
  let app: import('hono').Hono | undefined;
  const scopes: string[] = [];

  beforeAll(async () => {
    if (skip) return;
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: DATABASE_URL });
    const { buildApp } = await import('./index.js');
    app = buildApp(pool, pool, 4096);
  });

  afterAll(async () => {
    if (skip || !pool) return;
    for (const s of scopes) {
      await pool.query(`DROP TABLE IF EXISTS execution_event_log_scope_${s.replace(/-/g, '')} CASCADE`).catch(() => {});
      await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [s]).catch(() => {});
    }
    await pool.end();
  });

  async function newScope(): Promise<{ scopeId: string; planHash: string }> {
    const res = await app!.fetch(new Request('http://localhost/v1/scopes', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: 'adr58-test' }),
    }));
    const { scope_id } = (await res.json()) as { scope_id: string };
    scopes.push(scope_id);
    const { rows: [p] } = await pool!.query<{ version_hash: string }>(
      `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 LIMIT 1`, [scope_id]);
    return { scopeId: scope_id, planHash: p!.version_hash };
  }

  it.skipIf(skip)('task scope converges after its spawned task is completed', async () => {
    const { scopeId, planHash } = await newScope();
    const skill = `adr58-${randomUUID().slice(0, 8)}`;
    await mcp(app!, 1, 'register_agent', { agent_card: { agent_id: randomUUID(), name: 'a', description: 'a', skills: [skill], protocol: 'mcp', version: '1.0' } });

    // not converged before any task exists (EXISTS guard)
    expect((await checkConvergence(pool!, scopeId)).isConverged).toBe(false);

    const spawn = await mcp(app!, 2, 'spawn_subtask', { scope_id: scopeId, predecessor_hash: planHash, required_skills: [skill], payload: { description: 'work' } });
    const taskId = spawn['task_id'] as string;
    // not converged while the task is pending/processing
    expect((await checkConvergence(pool!, scopeId)).isConverged).toBe(false);

    await mcp(app!, 3, 'claim_next_task', { skills: [skill], scope_id: scopeId });
    expect((await checkConvergence(pool!, scopeId)).isConverged).toBe(false);

    await mcp(app!, 4, 'complete_task', { task_id: taskId, result: { output: 'done' } });
    // complete_task terminalized the task_spawned row → converged
    expect((await checkConvergence(pool!, scopeId)).isConverged).toBe(true);

    // and the task_spawned row is actually terminal
    const { rows } = await pool!.query<{ status: string }>(
      `SELECT status FROM execution_event_log WHERE scope_id = $1 AND event_type = 'task_spawned'`, [scopeId]);
    expect(rows[0]?.status).toBe('terminated');
  });

  it.skipIf(skip)('chat-style scope (memory_updated only) never converges', async () => {
    const { scopeId, planHash } = await newScope();
    // a conversation turn: a memory_updated event, no task_spawned
    await app!.fetch(new Request(`http://localhost/v1/scopes/${scopeId}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity_id: randomUUID(), event_type: 'memory_updated', payload: { turn: 'hi' }, predecessor_hash: planHash }),
    }));
    // no task_spawned → EXISTS guard keeps it open (ADR-54 conversations)
    expect((await checkConvergence(pool!, scopeId)).isConverged).toBe(false);
  });
});
