/**
 * Gate 4 integration test — GATE4-4: MCP end-to-end round trip
 *
 * Phase 3: Pattern Discovery + MCP Bridging
 *
 * Requires a real PostgreSQL database with migrations 001-007 applied.
 * Set DATABASE_URL env var to run. Tests skip automatically when DATABASE_URL is absent.
 *
 * GATE4-4: External Agent (MCP client) can call spawn_subtask + claim_next_task +
 *          complete_task against a live graph-os instance, with no event type
 *          outside the five canonical EVENT_TYPES written during the round trip.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

describe('GATE4-4: MCP end-to-end round trip', () => {
  let pool: import('pg').Pool | undefined;
  let app: import('hono').Hono | undefined;
  let scopeId: string | undefined;
  let agentId: string | undefined;

  beforeAll(async () => {
    if (skip) return;

    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: DATABASE_URL });

    const { buildApp } = await import('@graph/gateway/index.js');
    app = buildApp(pool, pool, 4096);
  });

  afterAll(async () => {
    if (skip) return;

    // Clean up agent registry row
    if (agentId && pool) {
      await pool.query(`DELETE FROM agent_registry WHERE agent_id = $1`, [agentId]).catch(() => {});
    }

    // Clean up scope partition
    if (scopeId && pool) {
      const nodash = scopeId.replace(/-/g, '');
      await pool
        .query(`DROP TABLE IF EXISTS execution_event_log_scope_${nodash} CASCADE`)
        .catch(() => {});
      await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [scopeId]).catch(() => {});
    }

    await pool?.end();
  });

  // ── 1. tools/list — assert exactly 7 tool names ───────────────────────────

  it.skipIf(skip)('tools/list returns exactly the 7 expected MCP tool names', async () => {
    if (!app) throw new Error('app not initialised');

    const res = await app.fetch(
      new Request('http://localhost/mcp/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { tools?: Array<{ name: string }> } };
    const toolNames = (body.result?.tools ?? []).map((t) => t.name).sort();

    const expected = [
      'claim_next_task',
      'complete_task',
      'get_task_status',
      'query_context',
      'register_agent',
      'spawn_subtask',
      'wait_all_tasks',
    ];
    expect(toolNames).toEqual(expected);
  });

  // ── 2. Full spawn → claim → complete round trip ────────────────────────────

  it.skipIf(skip)('GATE4-4: spawn_subtask → claim_next_task → complete_task end-to-end round trip', async () => {
    if (!app || !pool) throw new Error('app or pool not initialised');

    // ── Step 1: Create scope ─────────────────────────────────────────────────
    const scopeRes = await app.fetch(
      new Request('http://localhost/v1/scopes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'GATE4-4 MCP round trip test' }),
      }),
    );
    expect(scopeRes.status).toBe(201);
    const { scope_id } = (await scopeRes.json()) as { scope_id: string };
    scopeId = scope_id;

    // Get the plan_created version_hash — this is the correct predecessor for the first task_spawned.
    // ZERO_HASH is already owned by plan_created in the OCC chain; using it as predecessor
    // for spawn_subtask would trigger an OCC conflict and demote the write to conflict_detected.
    const { rows: [planRow] } = await pool.query<{ version_hash: string }>(
      `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 LIMIT 1`,
      [scopeId],
    );
    const planHash = planRow?.version_hash ?? '0'.repeat(64);

    // ── Step 2: register_agent with skills ['typescript'] ────────────────────
    const uniqueAgentId = randomUUID();
    const registerRes = await app.fetch(
      new Request('http://localhost/mcp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'register_agent',
            arguments: {
              agent_card: {
                agent_id: uniqueAgentId,
                name: 'GATE4-4 test agent',
                description: 'Integration test agent for GATE4-4',
                skills: ['typescript'],
                protocol: 'mcp',
                version: '1.0',
              },
            },
          },
        }),
      }),
    );
    expect(registerRes.status).toBe(200);
    const registerBody = (await registerRes.json()) as {
      result?: { content?: Array<{ text: string }> };
    };
    const registerResult = JSON.parse(registerBody.result?.content?.[0]?.text ?? '{}') as {
      registered?: string;
    };
    expect(registerResult.registered).toBeDefined();
    agentId = registerResult.registered;

    // ── Step 3: spawn_subtask with required_skills ['typescript'] ────────────
    const spawnRes = await app.fetch(
      new Request('http://localhost/mcp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'spawn_subtask',
            arguments: {
              scope_id,
              predecessor_hash: planHash,
              required_skills: ['typescript'],
              payload: { description: 'GATE4-4 spawned task' },
            },
          },
        }),
      }),
    );
    expect(spawnRes.status).toBe(200);
    const spawnBody = (await spawnRes.json()) as {
      result?: { content?: Array<{ text: string }> };
    };
    const spawnResult = JSON.parse(spawnBody.result?.content?.[0]?.text ?? '{}') as {
      task_id?: string;
    };
    expect(spawnResult.task_id).toBeDefined();
    const taskId = spawnResult.task_id!;

    // Verify task_spawned event exists in the ledger
    const { rows: spawnedRows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM execution_event_log
       WHERE scope_id = $1 AND entity_id = $2`,
      [scopeId, taskId],
    );
    expect(spawnedRows.length).toBeGreaterThanOrEqual(1);
    expect(spawnedRows[0]?.event_type).toBe('task_spawned');

    // ── Step 4: D-1 guard — spawn with assigned_agent_id must be rejected ────
    const d1GuardRes = await app.fetch(
      new Request('http://localhost/mcp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'spawn_subtask',
            arguments: {
              scope_id,
              predecessor_hash: '0'.repeat(64),
              required_skills: ['typescript'],
              payload: { assigned_agent_id: randomUUID() },
            },
          },
        }),
      }),
    );
    expect(d1GuardRes.status).toBe(200);
    const d1Body = (await d1GuardRes.json()) as { result?: { isError?: boolean } };
    // D-1 guard returns isError: true
    expect(d1Body.result?.isError).toBe(true);

    // ── Step 5: claim_next_task with skills ['typescript'] ───────────────────
    const claimRes = await app.fetch(
      new Request('http://localhost/mcp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: {
            name: 'claim_next_task',
            arguments: { skills: ['typescript'], scope_id },
          },
        }),
      }),
    );
    expect(claimRes.status).toBe(200);
    const claimBody = (await claimRes.json()) as {
      result?: { content?: Array<{ text: string }> };
    };
    const claimResult = JSON.parse(claimBody.result?.content?.[0]?.text ?? '{}') as {
      task_id?: string;
    };
    expect(claimResult.task_id).toBe(taskId);

    // Verify task is now in 'processing' status (SKIP LOCKED claim)
    const { rows: processingRows } = await pool.query<{ status: string }>(
      `SELECT status FROM execution_event_log
       WHERE scope_id = $1 AND entity_id = $2
       ORDER BY id DESC LIMIT 1`,
      [scopeId, taskId],
    );
    expect(processingRows[0]?.status).toBe('processing');

    // ── Step 6: complete_task with a result ──────────────────────────────────
    const completeRes = await app.fetch(
      new Request('http://localhost/mcp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'complete_task',
            arguments: {
              task_id: taskId,
              result: { output: 'GATE4-4 round trip complete', status: 'done' },
            },
          },
        }),
      }),
    );
    expect(completeRes.status).toBe(200);
    const completeBody = (await completeRes.json()) as {
      result?: { content?: Array<{ text: string }> };
    };
    const completeResult = JSON.parse(completeBody.result?.content?.[0]?.text ?? '{}') as {
      done?: boolean;
    };
    expect(completeResult.done).toBe(true);

    // Verify memory_updated event exists in the ledger
    const { rows: memRows } = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'memory_updated'`,
      [scopeId],
    );
    expect(memRows.length).toBeGreaterThanOrEqual(1);

    // ── Step 7: assert no event_type outside the 5 canonical EVENT_TYPES ─────
    const CANONICAL_TYPES = new Set([
      'plan_created',
      'task_spawned',
      'memory_updated',
      'conflict_detected',
      'scope_closed',
    ]);

    const { rows: allEvents } = await pool.query<{ event_type: string }>(
      `SELECT DISTINCT event_type FROM execution_event_log WHERE scope_id = $1`,
      [scopeId],
    );

    const nonCanonical = allEvents
      .map((r) => r.event_type)
      .filter((t) => !CANONICAL_TYPES.has(t));

    // sub_scope_resolved is a Control Plane direct-write (ADR 23) — it is
    // intentionally excluded from the EVENT_TYPES bus enum but may appear in
    // the ledger if nesting operations occur. For this round trip test we only
    // exercise the five canonical tool operations, so sub_scope_resolved must
    // not appear.
    expect(nonCanonical).toEqual([]);
  });
});
