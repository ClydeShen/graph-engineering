/**
 * buildMcpServer — registers the 7 MCP tools as cognitive-translation adapters
 * over the existing causal ledger (OCC writes + SKIP LOCKED claims).
 *
 * Tools expose only the two agent-writable canonical event types (ADR 12):
 *   task_spawned  — written by spawn_subtask
 *   memory_updated — written by complete_task
 *
 * D-1 guard: spawn_subtask rejects any payload containing assigned_agent_id
 * or preferred_agent. Routing is exclusively by required_skills (D-1 LOCKED).
 *
 * D-4: claim_next_task uses FOR UPDATE SKIP LOCKED — pull-primary model.
 *
 * @see ADR 12 — five canonical event types (no new type introduced here)
 * @see ADR 31 — FrontierScheduler skill-routing (D-1)
 * @see .planning/phases/03-pattern-discovery/03-05-PLAN.md
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { occWrite, checkCommand } from '@graph/shared';
import { ZERO_HASH, AGENT_HEARTBEAT_TTL_S } from '@graph/shared';
import { AgentCardSchema, registerAgent } from '../agent-registry.js';

const SCRUB_KEYS = new Set([
  'DATABASE_URL', 'LLM_API_KEY', 'GRAPH_RUNTIME_SECRET',
  'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY',
]);

function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SCRUB_KEYS.has(k)) out[k] = v;
  }
  return out;
}

// ── Zod primitives ──────────────────────────────────────────────────────────
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_HEX64 = /^[0-9a-f]{64}$/;

// ── CLAIM SQL — SKIP LOCKED (D-4 pull-primary) ──────────────────────────────
const CLAIM_SQL = `
  WITH candidate AS (
    SELECT id, entity_id, scope_id, payload, version_hash
    FROM execution_event_log
    WHERE status IN ('pending_dispatch', 'pending_scheduling')
      AND event_type = 'task_spawned'
      AND ($1::text[] IS NULL OR
           (payload::jsonb->>'required_skills')::jsonb ?| $1::text[])
      AND ($2::uuid IS NULL OR scope_id = $2::uuid)
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  )
  UPDATE execution_event_log e
  SET status = 'processing', last_active_at = NOW()
  FROM candidate
  WHERE e.id = candidate.id
  RETURNING
    candidate.entity_id AS task_id,
    candidate.scope_id,
    candidate.payload,
    candidate.version_hash
`;


// COMMAND GATE: any tool that executes user-supplied shell commands MUST call
// checkCommand() before execution. See packages/shared/src/command-gate.ts.

/**
 * Build a McpServer with all 7 tools registered.
 * The server instance is created once and reused across requests (Pitfall 2).
 */
export function buildMcpServer(pool: Pool): McpServer {
  const server = new McpServer({ name: 'graph-os', version: '1.0.0' });

  // ── Tool 1: spawn_subtask ────────────────────────────────────────────────
  server.registerTool(
    'spawn_subtask',
    {
      description:
        'Spawn a sub-task in the causal ledger. Writes a task_spawned event. ' +
        'Returns the task_id. D-1: payload must NOT contain assigned_agent_id or preferred_agent.',
      inputSchema: z.object({
        required_skills: z.array(z.string()).min(1),
        scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
        predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
        payload: z.record(z.string(), z.unknown()).default({}),
      }),
    },
    async ({ required_skills, scope_id, predecessor_hash, payload }) => {
      // D-1 GUARD: reject explicit agent assignment
      if ('assigned_agent_id' in payload || 'preferred_agent' in payload) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'REJECTED: explicit agent assignment forbidden (D-1). Use required_skills for routing.',
            },
          ],
        };
      }

      const entityId = randomUUID();
      const mergedPayload = { ...payload, required_skills, status: 'pending_scheduling' };

      try {
        await occWrite(pool, {
          scopeId: scope_id,
          entityId,
          predecessorHash: predecessor_hash,
          eventType: 'task_spawned',
          payload: mergedPayload,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[spawn_subtask] occWrite error:', msg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ task_id: entityId }) }],
      };
    },
  );

  // ── Tool 2: claim_next_task ──────────────────────────────────────────────
  server.registerTool(
    'claim_next_task',
    {
      description:
        'Atomically claim the next available task matching the given skills. ' +
        'Uses FOR UPDATE SKIP LOCKED (D-4 pull-primary). Returns task or empty object.',
      inputSchema: z.object({
        skills: z.array(z.string()).min(1),
        scope_id: z.string().regex(UUID_V4).optional(),
      }),
    },
    async ({ skills, scope_id }) => {
      const result = await pool.query<{
        task_id: string;
        scope_id: string;
        payload: string;
        version_hash: string;
      }>(CLAIM_SQL, [skills, scope_id ?? null]);

      if (result.rows.length === 0) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({}) }] };
      }

      const row = result.rows[0];
      let parsedPayload: unknown = {};
      try {
        parsedPayload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      } catch {
        // leave as empty object
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              task_id: row.task_id,
              scope_id: row.scope_id,
              payload: parsedPayload,
              predecessor_hash: row.version_hash,
            }),
          },
        ],
      };
    },
  );

  // ── Tool 3: get_task_status ──────────────────────────────────────────────
  server.registerTool(
    'get_task_status',
    {
      description: 'Query the current status and latest version_hash for a task entity.',
      inputSchema: z.object({
        task_id: z.string().uuid(),
      }),
    },
    async ({ task_id }) => {
      const result = await pool.query<{
        status: string;
        version_hash: string;
        scope_id: string;
        event_type: string;
      }>(
        `SELECT status, version_hash, scope_id, event_type
         FROM execution_event_log
         WHERE entity_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [task_id],
      );

      if (result.rows.length === 0) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'task not found', task_id }) }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.rows[0]) }],
      };
    },
  );

  // ── Tool 4: complete_task ────────────────────────────────────────────────
  server.registerTool(
    'complete_task',
    {
      description:
        'Mark a task as done by writing a memory_updated event to the causal ledger. Returns { done: true }.',
      inputSchema: z.object({
        task_id: z.string().uuid(),
        result: z.record(z.string(), z.unknown()).default({}),
        // scope_id and predecessor_hash are optional — looked up from the ledger if omitted
        scope_id: z.string().regex(UUID_V4).optional(),
        predecessor_hash: z.string().regex(HASH_HEX64).optional(),
      }),
    },
    async ({ task_id, result, scope_id, predecessor_hash }) => {
      // Look up scope_id and latest version_hash from ledger if not supplied
      let resolvedScopeId = scope_id;
      let resolvedPredHash = predecessor_hash;

      if (!resolvedScopeId || !resolvedPredHash) {
        const lookup = await pool.query<{ scope_id: string; version_hash: string }>(
          `SELECT scope_id, version_hash
           FROM execution_event_log
           WHERE entity_id = $1
           ORDER BY created_at DESC
           LIMIT 1`,
          [task_id],
        );
        if (lookup.rows.length === 0) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'task not found', task_id }) }],
          };
        }
        resolvedScopeId = resolvedScopeId ?? lookup.rows[0].scope_id;
        resolvedPredHash = resolvedPredHash ?? lookup.rows[0].version_hash;
      }

      await occWrite(pool, {
        scopeId: resolvedScopeId,
        entityId: task_id,
        predecessorHash: resolvedPredHash,
        eventType: 'memory_updated',
        payload: { ...result, status: 'completed' },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ done: true }) }],
      };
    },
  );

  // ── Tool 5: wait_all_tasks ───────────────────────────────────────────────
  // NOTE: Phase 3 implementation uses polling with LISTEN/NOTIFY basis.
  // Partial-completion semantics are deferred to Phase 4 per CONTEXT.md.
  // Decision recorded in .harness/implementation-notes.md.
  server.registerTool(
    'wait_all_tasks',
    {
      description:
        'Wait for all specified tasks to reach a terminal state (completed or failed). ' +
        'On timeout returns { timed_out: true, completed: [], pending: [] }. ' +
        'Partial-completion semantics are Phase 4 scope.',
      inputSchema: z.object({
        task_ids: z.array(z.string().uuid()).min(1),
        timeout_s: z.number().min(1).max(600).default(60),
      }),
    },
    async ({ task_ids, timeout_s }) => {
      const deadline = Date.now() + timeout_s * 1000;
      const POLL_INTERVAL_MS = 2000;

      while (Date.now() < deadline) {
        const result = await pool.query<{ entity_id: string; status: string }>(
          `SELECT DISTINCT ON (entity_id) entity_id, status
           FROM execution_event_log
           WHERE entity_id = ANY($1::uuid[])
           ORDER BY entity_id, created_at DESC`,
          [task_ids],
        );

        const statusMap = new Map(result.rows.map((r) => [r.entity_id, r.status]));
        const completed: string[] = [];
        const pending: string[] = [];

        for (const id of task_ids) {
          const s = statusMap.get(id) ?? 'unknown';
          if (s === 'completed' || s === 'done') {
            completed.push(id);
          } else {
            pending.push(id);
          }
        }

        if (pending.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ timed_out: false, completed, pending: [] }) },
            ],
          };
        }

        // Wait before next poll (bounded by deadline)
        const waitMs = Math.min(POLL_INTERVAL_MS, deadline - Date.now());
        if (waitMs > 0) {
          await new Promise<void>((r) => setTimeout(r, waitMs));
        }
      }

      // Timeout — return partial state
      const result = await pool.query<{ entity_id: string; status: string }>(
        `SELECT DISTINCT ON (entity_id) entity_id, status
         FROM execution_event_log
         WHERE entity_id = ANY($1::uuid[])
         ORDER BY entity_id, created_at DESC`,
        [task_ids],
      );
      const statusMap = new Map(result.rows.map((r) => [r.entity_id, r.status]));
      const completed = task_ids.filter(
        (id) => statusMap.get(id) === 'completed' || statusMap.get(id) === 'done',
      );
      const pending = task_ids.filter((id) => !completed.includes(id));

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ timed_out: true, completed, pending }) },
        ],
      };
    },
  );

  // ── Tool 6: register_agent ───────────────────────────────────────────────
  server.registerTool(
    'register_agent',
    {
      description:
        'Register an external Agent by storing its AgentCard in agent_registry. ' +
        'ON CONFLICT (agent_id) refreshes last_heartbeat and status. Returns { registered: agent_id }.',
      inputSchema: z.object({
        agent_card: AgentCardSchema,
      }),
    },
    async ({ agent_card }) => {
      try {
        const { agent_id } = await registerAgent(pool, agent_card);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ registered: agent_id }) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[register_agent] DB error:', msg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        };
      }
    },
  );

  // ── Tool 7: query_context ────────────────────────────────────────────────
  server.registerTool(
    'query_context',
    {
      description:
        'Read a causal-chain summary for the given scope. ' +
        'Returns recent events scoped to scope_id only (T-03-05-05).',
      inputSchema: z.object({
        scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
        limit: z.number().min(1).max(100).default(20),
      }),
    },
    async ({ scope_id, limit }) => {
      const result = await pool.query<{
        entity_id: string;
        event_type: string;
        version_hash: string;
        status: string;
        created_at: Date;
      }>(
        `SELECT entity_id, event_type, version_hash, status, created_at
         FROM execution_event_log
         WHERE scope_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [scope_id, limit],
      );

      const summary = {
        scope_id,
        event_count: result.rows.length,
        events: result.rows.map((r) => ({
          entity_id: r.entity_id,
          event_type: r.event_type,
          version_hash: r.version_hash,
          status: r.status,
          created_at: r.created_at,
        })),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(summary) }],
      };
    },
  );

  // ── Tool 8: execute_bash (conditional on EXECUTE_BASH_ENABLED) ──────────────
  if (process.env['EXECUTE_BASH_ENABLED'] === 'true') {
    const EXECUTE_BASH_CWD = process.env['EXECUTE_BASH_CWD'] ?? tmpdir();

    server.registerTool(
      'execute_bash',
      {
        description:
          'Execute a bash command on the host. Gated by CommandGate — hardline and dangerous ' +
          'commands are blocked. Requires EXECUTE_BASH_ENABLED=true.',
        inputSchema: z.object({
          command: z.string().min(1).max(4096),
          scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
          predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
        }),
      },
      async ({ command, scope_id, predecessor_hash }) => {
        const verdict = checkCommand(command);
        const entityId = randomUUID();

        if (!verdict.allowed) {
          // Write blocked-attempt audit event — failures are first-class graph events
          try {
            await occWrite(pool, {
              scopeId: scope_id,
              entityId,
              predecessorHash: predecessor_hash,
              eventType: 'memory_updated',
              payload: { command, status: 'blocked', tier: verdict.tier, reason: verdict.reason },
            });
          } catch {
            // best-effort; must not suppress the block response
          }
          const msg =
            verdict.tier === 'hardline'
              ? `BLOCKED (hardline): ${verdict.reason}. Cannot execute.`
              : `BLOCKED (requires approval): ${verdict.reason}. Use the graph runtime console to approve.`;
          return { isError: true, content: [{ type: 'text' as const, text: msg }] };
        }

        try {
          const execAsync = promisify(exec);
          const { stdout, stderr } = await execAsync(command, {
            timeout: 30000,
            maxBuffer: 512 * 1024,
            cwd: EXECUTE_BASH_CWD,
            env: scrubEnv(process.env),
          });
          await occWrite(pool, {
            scopeId: scope_id,
            entityId,
            predecessorHash: predecessor_hash,
            eventType: 'memory_updated',
            payload: { command, stdout, stderr, exit_code: 0 },
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ stdout, stderr, exit_code: 0 }) },
            ],
          };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
          if (typeof e.code === 'number') {
            // Non-zero exit — record result, not an error
            try {
              await occWrite(pool, {
                scopeId: scope_id,
                entityId,
                predecessorHash: predecessor_hash,
                eventType: 'memory_updated',
                payload: { command, stdout: e.stdout ?? '', stderr: e.stderr ?? '', exit_code: e.code },
              });
            } catch {
              // best-effort
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', exit_code: e.code }),
                },
              ],
            };
          }
          // Timeout or maxBuffer exceeded
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message ?? String(err) }) }],
          };
        }
      },
    );
  }

  return server;
}

// Re-export ZERO_HASH for convenience (used in tests)
export { ZERO_HASH };
