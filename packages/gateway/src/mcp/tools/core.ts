/**
 * Core MCP tools — cognitive-translation adapters over the causal ledger
 * (OCC writes + SKIP LOCKED claims). The original seven (ADR 12 / ADR 31 / ADR 46).
 *
 * Tools expose only the two agent-writable canonical event types (ADR 12):
 *   task_spawned  — written by spawn_subtask
 *   memory_updated — written by complete_task
 *
 * D-1 guard: spawn_subtask rejects any payload containing assigned_agent_id or
 * preferred_agent. Routing is exclusively by required_skills (D-1 LOCKED).
 * D-4: claim_next_task uses FOR UPDATE SKIP LOCKED — pull-primary model.
 */
import { z } from 'zod';
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { occWrite } from '@graph/shared';
import { AgentCardSchema, registerAgent } from '../../agent-registry.js';
import { UUID_V4, HASH_HEX64, type McpToolDef, type McpToolFactory } from './types.js';

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

// ── spawn_subtask ─────────────────────────────────────────────────────────────
const SpawnSchema = z.object({
  required_skills: z.array(z.string()).min(1),
  scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
  predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
  payload: z.record(z.string(), z.unknown()).default({}),
});

async function handleSpawnSubtask(pool: Pool, args: z.infer<typeof SpawnSchema>): Promise<CallToolResult> {
  const { required_skills, scope_id, predecessor_hash, payload } = args;
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
}

export const spawnSubtaskTool: McpToolFactory = (pool): McpToolDef => ({
  name: 'spawn_subtask',
  description:
    'Spawn a sub-task in the causal ledger. Writes a task_spawned event. ' +
    'Returns the task_id. D-1: payload must NOT contain assigned_agent_id or preferred_agent.',
  inputSchema: SpawnSchema,
  handler: (args) => handleSpawnSubtask(pool, args as z.infer<typeof SpawnSchema>),
});

// ── claim_next_task ─────────────────────────────────────────────────────────
const ClaimSchema = z.object({
  skills: z.array(z.string()).min(1),
  scope_id: z.string().regex(UUID_V4).optional(),
});

async function handleClaimNextTask(pool: Pool, args: z.infer<typeof ClaimSchema>): Promise<CallToolResult> {
  const { skills, scope_id } = args;
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
}

export const claimNextTaskTool: McpToolFactory = (pool): McpToolDef => ({
  name: 'claim_next_task',
  description:
    'Atomically claim the next available task matching the given skills. ' +
    'Uses FOR UPDATE SKIP LOCKED (D-4 pull-primary). Returns task or empty object.',
  inputSchema: ClaimSchema,
  handler: (args) => handleClaimNextTask(pool, args as z.infer<typeof ClaimSchema>),
});

// ── get_task_status ─────────────────────────────────────────────────────────
const GetStatusSchema = z.object({
  task_id: z.string().uuid(),
});

async function handleGetTaskStatus(pool: Pool, args: z.infer<typeof GetStatusSchema>): Promise<CallToolResult> {
  const { task_id } = args;
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
}

export const getTaskStatusTool: McpToolFactory = (pool): McpToolDef => ({
  name: 'get_task_status',
  description: 'Query the current status and latest version_hash for a task entity.',
  inputSchema: GetStatusSchema,
  handler: (args) => handleGetTaskStatus(pool, args as z.infer<typeof GetStatusSchema>),
});

// ── complete_task ─────────────────────────────────────────────────────────────
const CompleteSchema = z.object({
  task_id: z.string().uuid(),
  result: z.record(z.string(), z.unknown()).default({}),
  // scope_id and predecessor_hash are optional — looked up from the ledger if omitted
  scope_id: z.string().regex(UUID_V4).optional(),
  predecessor_hash: z.string().regex(HASH_HEX64).optional(),
});

async function handleCompleteTask(pool: Pool, args: z.infer<typeof CompleteSchema>): Promise<CallToolResult> {
  const { task_id, result, scope_id, predecessor_hash } = args;
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

  // ADR-58: terminalize the task_spawned row so the scope can converge. The
  // completion above only appends a memory_updated record; without this the
  // task_spawned row stays 'processing'/'pending_scheduling' forever and the
  // convergence SQL (which now counts task_spawned) never flips. Status is
  // mutable metadata (not in the version_hash) — same append-safe UPDATE pattern
  // as claim (→processing) and frontier cycle-kill (→terminated).
  await pool.query(
    `UPDATE execution_event_log SET status = 'terminated'
     WHERE scope_id = $1 AND entity_id = $2 AND event_type = 'task_spawned'`,
    [resolvedScopeId, task_id],
  );

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ done: true }) }],
  };
}

export const completeTaskTool: McpToolFactory = (pool): McpToolDef => ({
  name: 'complete_task',
  description:
    'Mark a task as done by writing a memory_updated event to the causal ledger. Returns { done: true }.',
  inputSchema: CompleteSchema,
  handler: (args) => handleCompleteTask(pool, args as z.infer<typeof CompleteSchema>),
});

// ── wait_all_tasks ─────────────────────────────────────────────────────────────
// TD-K (ADR-46 D-8): event-driven via LISTEN graph_event_ready with a 10s
// safety-net poll — replaces the Phase 3 fixed 2s polling. Return shape is
// unchanged ({ timed_out, completed, pending }) for backward compatibility.
const WaitSchema = z.object({
  task_ids: z.array(z.string().uuid()).min(1),
  timeout_s: z.number().min(1).max(600).default(60),
});

async function handleWaitAllTasks(pool: Pool, args: z.infer<typeof WaitSchema>): Promise<CallToolResult> {
  const { task_ids, timeout_s } = args;
  const deadline = Date.now() + timeout_s * 1000;
  const FALLBACK_POLL_MS = 10_000;

  const checkStatus = async (): Promise<{ completed: string[]; pending: string[] }> => {
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
      if (s === 'completed' || s === 'done') completed.push(id);
      else pending.push(id);
    }
    return { completed, pending };
  };

  const client = await pool.connect();
  let wake: (() => void) | null = null;
  try {
    await client.query('LISTEN graph_event_ready');
    client.on('notification', () => {
      wake?.();
    });

    while (Date.now() < deadline) {
      const { completed, pending } = await checkStatus();
      if (pending.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ timed_out: false, completed, pending: [] }) },
          ],
        };
      }
      // Sleep until the next graph event or the fallback poll, bounded by deadline.
      const waitMs = Math.min(FALLBACK_POLL_MS, deadline - Date.now());
      if (waitMs <= 0) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, waitMs);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    wake = null;
    await client.query('UNLISTEN *').catch(() => {});
    client.release();
  }

  // Timeout — return partial state
  const { completed, pending } = await checkStatus();
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ timed_out: true, completed, pending }) },
    ],
  };
}

export const waitAllTasksTool: McpToolFactory = (pool): McpToolDef => ({
  name: 'wait_all_tasks',
  description:
    'Wait for all specified tasks to reach a terminal state (completed or failed). ' +
    'On timeout returns { timed_out: true, completed: [], pending: [] }. ' +
    'Event-driven (LISTEN/NOTIFY) with a 10s safety-net poll.',
  inputSchema: WaitSchema,
  handler: (args) => handleWaitAllTasks(pool, args as z.infer<typeof WaitSchema>),
});

// ── register_agent ─────────────────────────────────────────────────────────────
const RegisterAgentSchema = z.object({
  agent_card: AgentCardSchema,
});

async function handleRegisterAgent(pool: Pool, args: z.infer<typeof RegisterAgentSchema>): Promise<CallToolResult> {
  const { agent_card } = args;
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
}

export const registerAgentTool: McpToolFactory = (pool): McpToolDef => ({
  name: 'register_agent',
  description:
    'Register an external Agent by storing its AgentCard in agent_registry. ' +
    'ON CONFLICT (agent_id) refreshes last_heartbeat and status. Returns { registered: agent_id }.',
  inputSchema: RegisterAgentSchema,
  handler: (args) => handleRegisterAgent(pool, args as z.infer<typeof RegisterAgentSchema>),
});

// ── query_context ─────────────────────────────────────────────────────────────
const QueryContextSchema = z.object({
  scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
  limit: z.number().min(1).max(100).default(20),
});

async function handleQueryContext(pool: Pool, args: z.infer<typeof QueryContextSchema>): Promise<CallToolResult> {
  const { scope_id, limit } = args;
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
}

export const queryContextTool: McpToolFactory = (pool): McpToolDef => ({
  name: 'query_context',
  description:
    'Read a causal-chain summary for the given scope. ' +
    'Returns recent events scoped to scope_id only (T-03-05-05).',
  inputSchema: QueryContextSchema,
  handler: (args) => handleQueryContext(pool, args as z.infer<typeof QueryContextSchema>),
});
