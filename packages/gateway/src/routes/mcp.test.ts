/**
 * mcp.test.ts
 *
 * GATE4-4: External Agent (MCP client) can call spawn_subtask + claim_next_task
 * + complete_task against a live graph-os instance.
 * Turned GREEN by: Plan 03-05 (MCP Server + 7 tools implementation).
 *
 * This test is DB-gated (skip without DATABASE_URL) and references the MCP route
 * that does not yet exist (packages/gateway/src/routes/mcp.ts + mcp server).
 * That is the intended RED state.
 *
 * MCP tool names (7 total per CONTEXT.md §"MCP Tools to Implement"):
 *   spawn_subtask, claim_next_task, get_task_status, complete_task,
 *   wait_all_tasks, register_agent, query_context
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

describe('MCP route — tools/list and spawn→claim→complete sequence (GATE4-4)', () => {
  let pool: import('pg').Pool | undefined;
  let app: import('hono').Hono | undefined;

  beforeAll(async () => {
    if (skip) return;
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: DATABASE_URL });

    // Import the gateway app — mcp.ts route not yet mounted; this import fails
    // until Plan 03-05 creates mcp.ts and wires it into buildApp().
    // That failure is the intended RED state.
    try {
      const { buildApp } = await import('@graph/gateway/index.js');
      app = buildApp(pool, pool, 4096);
    } catch {
      app = undefined;
    }
  });

  afterAll(async () => {
    if (skip) return;
    await pool?.end();
  });

  // ── GATE4-4a: tools/list returns the 7 expected MCP tool names ───────────────

  it.skipIf(skip)(
    'GATE4-4a: POST /mcp/messages with tools/list JSON-RPC returns the 7 expected tool names',
    async () => {
      if (!app) {
        expect.fail('RED: MCP route (mcp.ts) not yet implemented (Plan 03-05 turns this GREEN)');
      }

      const rpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const res = await app.fetch(
        new Request('http://localhost/mcp/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify(rpcRequest),
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        result?: { tools?: Array<{ name: string }> };
      };

      const toolNames = body.result?.tools?.map((t) => t.name) ?? [];
      const expectedTools = [
        'spawn_subtask',
        'claim_next_task',
        'get_task_status',
        'complete_task',
        'wait_all_tasks',
        'register_agent',
        'query_context',
      ];

      expect(toolNames.sort()).toEqual(expectedTools.sort());
    },
  );

  // ── GATE4-4b: spawn → claim → complete sequence writes expected events ────────

  it.skipIf(skip)(
    'GATE4-4b: spawn_subtask → claim_next_task → complete_task sequence writes expected events',
    async () => {
      if (!app || !pool) {
        expect.fail('RED: MCP route (mcp.ts) not yet implemented (Plan 03-05 turns this GREEN)');
      }

      // Step 1: Create a scope first (required for OCC ledger writes)
      const scopeRes = await app.fetch(
        new Request('http://localhost/v1/scopes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intent: 'GATE4-4 test scope' }),
        }),
      );
      expect(scopeRes.status).toBe(201);
      const { scope_id } = (await scopeRes.json()) as { scope_id: string };

      // Get plan_created version_hash — correct predecessor for first task_spawned.
      // ZERO_HASH is owned by plan_created; reusing it causes OCC conflict.
      const { rows: [planRow] } = await pool.query<{ version_hash: string }>(
        `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 LIMIT 1`,
        [scope_id],
      );
      const planHash = planRow?.version_hash ?? '0'.repeat(64);

      // Step 2: spawn_subtask — writes task_spawned event, returns task_id
      const spawnRes = await app.fetch(
        new Request('http://localhost/mcp/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'spawn_subtask',
              arguments: {
                scope_id,
                predecessor_hash: planHash,
                required_skills: ['test-skill'],
                payload: { test: true },
              },
            },
          }),
        }),
      );
      expect(spawnRes.status).toBe(200);
      const spawnBody = (await spawnRes.json()) as { result?: { content?: Array<{ text: string }> } };
      const spawnResult = JSON.parse(spawnBody.result?.content?.[0]?.text ?? '{}') as { task_id?: string };
      expect(spawnResult.task_id).toBeDefined();
      const taskId = spawnResult.task_id!;

      // Step 3: claim_next_task — SKIP LOCKED atomic claim, returns task
      const claimRes = await app.fetch(
        new Request('http://localhost/mcp/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: {
              name: 'claim_next_task',
              arguments: { skills: ['test-skill'] },
            },
          }),
        }),
      );
      expect(claimRes.status).toBe(200);

      // Step 4: complete_task — writes memory_updated event, marks done
      const completeRes = await app.fetch(
        new Request('http://localhost/mcp/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 4,
            method: 'tools/call',
            params: {
              name: 'complete_task',
              arguments: {
                task_id: taskId,
                result: { status: 'done', output: 'GATE4-4 test complete' },
              },
            },
          }),
        }),
      );
      expect(completeRes.status).toBe(200);

      // Verify the expected events were written to execution_event_log
      const { rows } = await pool.query<{ event_type: string }>(
        `SELECT event_type FROM execution_event_log WHERE scope_id = $1 ORDER BY created_at ASC`,
        [scope_id],
      );
      const eventTypes = rows.map((r) => r.event_type);
      expect(eventTypes).toContain('task_spawned');
      expect(eventTypes).toContain('memory_updated');
    },
  );
});

// ── execute_bash unit tests (no DB required) ────────────────────────────────

const mockExec = vi.fn();
vi.mock('child_process', () => ({ exec: mockExec }));

function makeMockPool(): import('pg').Pool {
  return {
    query: vi.fn().mockResolvedValue({
      rows: [{ event_type: 'memory_updated', version_hash: '0'.repeat(64), occ_result: 'won' }],
    }),
  } as unknown as import('pg').Pool;
}

async function callExecuteBash(
  pool: import('pg').Pool,
  args: { command: string; scope_id: string; predecessor_hash: string },
): Promise<{ status: number; body: unknown }> {
  const { buildMcpRoute } = await import('../routes/mcp.js');
  const app = buildMcpRoute(pool);
  const res = await app.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'execute_bash', arguments: args },
      }),
    }),
  );
  return { status: res.status, body: await res.json() };
}

const SCOPE_ID = '33333333-3333-4333-8333-333333333333';
const PRED_HASH = '0'.repeat(64);

describe('execute_bash MCP tool', () => {
  beforeEach(() => {
    process.env['EXECUTE_BASH_ENABLED'] = 'true';
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env['EXECUTE_BASH_ENABLED'];
  });

  it('returns isError for hardline-blocked command (rm -rf /)', async () => {
    const pool = makeMockPool();
    const { status, body } = await callExecuteBash(pool, {
      command: 'rm -rf /',
      scope_id: SCOPE_ID,
      predecessor_hash: PRED_HASH,
    });
    expect(status).toBe(200);
    const b = body as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(b.result?.isError).toBe(true);
    expect(b.result?.content?.[0]?.text).toMatch(/BLOCKED \(hardline\)/);
  });

  it('returns isError for dangerous-blocked command (rm -rf ~/)', async () => {
    const pool = makeMockPool();
    const { status, body } = await callExecuteBash(pool, {
      command: 'rm -rf ~/',
      scope_id: SCOPE_ID,
      predecessor_hash: PRED_HASH,
    });
    expect(status).toBe(200);
    const b = body as { result?: { isError?: boolean; content?: Array<{ text: string }> } };
    expect(b.result?.isError).toBe(true);
    expect(b.result?.content?.[0]?.text).toMatch(/BLOCKED/);
  });

  it('executes safe command and returns stdout', async () => {
    // promisify(exec) uses util.promisify.custom = Symbol.for('nodejs.util.promisify.custom')
    // to resolve { stdout, stderr } rather than a plain string. Set it on the mock so the
    // handler receives the correct shape.
    const customSymbol = Symbol.for('nodejs.util.promisify.custom');
    (mockExec as unknown as Record<symbol, unknown>)[customSymbol] = () =>
      Promise.resolve({ stdout: 'hello\n', stderr: '' });
    const pool = makeMockPool();
    const { status, body } = await callExecuteBash(pool, {
      command: 'echo hello',
      scope_id: SCOPE_ID,
      predecessor_hash: PRED_HASH,
    });
    expect(status).toBe(200);
    const b = body as { result?: { content?: Array<{ text: string }> } };
    const result = JSON.parse(b.result?.content?.[0]?.text ?? '{}') as {
      stdout: string;
      exit_code: number;
    };
    expect(result.stdout).toBe('hello\n');
    expect(result.exit_code).toBe(0);
  });
});
