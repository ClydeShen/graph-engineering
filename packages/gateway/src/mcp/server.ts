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
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { occWrite, checkCommand, projectFromCwd, recordScopeProject } from '@graph/shared';
import { ZERO_HASH, AGENT_HEARTBEAT_TTL_S } from '@graph/shared';
import {
  formatGuardReport,
  injectSecrets,
  installSkill,
  profileDir,
  REGISTRIES,
  resolveBindings,
  saveArtifact,
  scanSkillContent,
  searchSkills,
} from '@graph/shared';
import { AgentCardSchema, registerAgent } from '../agent-registry.js';
import { ApprovalService } from '../security/approval.js';
import { AskUserService } from '../security/ask-user.js';
import { requestInstall, executeInstall, searchCapabilities } from '../security/acquisition.js';
import { buildBrowserRunArgs } from '../security/browser-capability.js';
import {
  buildDockerRunArgs,
  approvalRequiredForBackend,
  resolveExecBackend,
} from '../security/exec-backend.js';

const SCRUB_KEYS = new Set([
  'DATABASE_URL', 'LLM_API_KEY', 'GRAPH_RUNTIME_SECRET',
  'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY',
  // Phase 20: the vault KEK must never reach execute_bash subprocesses —
  // with it, container/host code could unwrap every stored credential.
  'MEMEX_VAULT_KEK', 'MEMEX_GATEWAY_TOKEN',
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
  // TD-K (ADR-46 D-8): event-driven via LISTEN graph_event_ready with a 10s
  // safety-net poll — replaces the Phase 3 fixed 2s polling. Return shape is
  // unchanged ({ timed_out, completed, pending }) for backward compatibility.
  server.registerTool(
    'wait_all_tasks',
    {
      description:
        'Wait for all specified tasks to reach a terminal state (completed or failed). ' +
        'On timeout returns { timed_out: true, completed: [], pending: [] }. ' +
        'Event-driven (LISTEN/NOTIFY) with a 10s safety-net poll.',
      inputSchema: z.object({
        task_ids: z.array(z.string().uuid()).min(1),
        timeout_s: z.number().min(1).max(600).default(60),
      }),
    },
    async ({ task_ids, timeout_s }) => {
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

        // ADR-47 D-4: the backend decides containment. Fail-closed when docker is
        // requested but unreachable — never silently run on the host, because the
        // docker backend bypasses dangerous-pattern approval (contained commands
        // can't reach the host; host exec with that bypass would be catastrophic).
        const backend = await resolveExecBackend();
        if (backend === null) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  'BLOCKED: EXEC_BACKEND=docker but docker is unreachable. Refusing to fall ' +
                  'back to host execution (fail-closed). Start docker or unset EXEC_BACKEND.',
              },
            ],
          };
        }

        const gate = approvalRequiredForBackend(backend, verdict);
        // (!verdict.allowed narrows the union; gate flags are only set when blocked.)
        if (!verdict.allowed && (gate.blocked || gate.requiresApproval)) {
          // Blocked-attempt audit — failures are first-class graph events.
          try {
            await occWrite(pool, {
              scopeId: scope_id,
              entityId,
              predecessorHash: predecessor_hash,
              eventType: 'memory_updated',
              payload: { command, status: 'blocked', tier: verdict.tier, reason: verdict.reason, backend },
            });
          } catch {
            // best-effort; must not suppress the block response
          }
          const msg = gate.blocked
            ? `BLOCKED (hardline): ${verdict.reason}. Cannot execute.`
            : `BLOCKED (requires approval): ${verdict.reason}. Use the graph runtime console to approve.`;
          return { isError: true, content: [{ type: 'text' as const, text: msg }] };
        }

        // A dangerous command reaching here ran CONTAINED (docker bypassed approval
        // because it cannot reach the host) — mark it in the trail.
        const ranContained = backend === 'docker' && !verdict.allowed;

        try {
          let stdout: string;
          let stderr: string;
          if (backend === 'docker') {
            const execFileAsync = promisify(execFile);
            const args = buildDockerRunArgs(command, {
              network: 'none', // execute_bash gets NO egress (contrast: browser=bridge)
              ...(process.env['EXECUTE_BASH_IMAGE']
                ? { image: process.env['EXECUTE_BASH_IMAGE'] }
                : {}),
            });
            ({ stdout, stderr } = await execFileAsync('docker', args, {
              timeout: 35000, // container spin-up + command
              maxBuffer: 512 * 1024,
            }));
          } else {
            // CONSOLE-REDESIGN §11.1: the local working folder is this scope's
            // project. Record it (first-write-wins) so the Now universe clusters
            // and the Workspace page groups by it. tmp/ephemeral cwd → no project.
            const project = projectFromCwd(EXECUTE_BASH_CWD);
            if (project) await recordScopeProject(pool, scope_id, project);
            const execAsync = promisify(exec);
            ({ stdout, stderr } = await execAsync(command, {
              timeout: 30000,
              maxBuffer: 512 * 1024,
              cwd: EXECUTE_BASH_CWD,
              env: scrubEnv(process.env),
            }));
          }
          await occWrite(pool, {
            scopeId: scope_id,
            entityId,
            predecessorHash: predecessor_hash,
            eventType: 'memory_updated',
            payload: {
              command,
              stdout,
              stderr,
              exit_code: 0,
              backend,
              ...(ranContained ? { tier: verdict.tier, approval_bypassed: true } : {}),
            },
          });
          return {
            content: [
              { type: 'text' as const, text: JSON.stringify({ stdout, stderr, exit_code: 0, backend }) },
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
                payload: { command, stdout: e.stdout ?? '', stderr: e.stderr ?? '', exit_code: e.code, backend },
              });
            } catch {
              // best-effort
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', exit_code: e.code, backend }),
                },
              ],
            };
          }
          // Timeout or maxBuffer exceeded
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: e.message ?? String(err), backend }) }],
          };
        }
      },
    );
  }

  // ── Phase 20 (ADR-53): autonomous-assistant tool family ─────────────────────
  // Trust gating happens at the HTTP MCP route (isToolAllowed interception);
  // capability_install and browser are PAIRED_DENIED — trusted principals only.
  const approvals = new ApprovalService(pool);
  const askUser = new AskUserService(pool);

  // Tool 9: ask_user — approvals generalized to free-form Q&A. Q&A pairs are
  // trail data: "always asks at this step" is a Trail Discovery signal.
  server.registerTool(
    'ask_user',
    {
      description:
        'Ask the human a free-form question. Returns a question_id immediately; ' +
        'poll ask_user_status for the answer. Silence (10 min) = timed_out.',
      inputSchema: z.object({
        question: z.string().min(1).max(2000),
        scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
        predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
        principal: z.string().max(128).default('mcp-agent'),
      }),
    },
    async ({ question, scope_id, predecessor_hash, principal }) => {
      const questionId = await askUser.ask(scope_id, principal, question);
      try {
        await occWrite(pool, {
          scopeId: scope_id,
          entityId: randomUUID(),
          predecessorHash: predecessor_hash,
          eventType: 'memory_updated',
          payload: { kind: 'memex::ask_user::asked', question_id: questionId, question },
        });
      } catch {
        /* trail mark is best-effort; the question row is authoritative */
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ question_id: questionId, status: 'pending' }) },
        ],
      };
    },
  );

  // Tool 10: ask_user_status — poll for the answer.
  server.registerTool(
    'ask_user_status',
    {
      description: 'Check an ask_user question: pending | answered (+answer) | timed_out.',
      inputSchema: z.object({ question_id: z.string().regex(UUID_V4) }),
    },
    async ({ question_id }) => {
      const result = await askUser.status(question_id);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(result ?? { status: 'unknown_question' }) },
        ],
      };
    },
  );

  // Tool 11: capability_search — unified search over presets + skill registries
  // (ADR-51 verb family: search_catalog; no `select` — the agent chooses).
  server.registerTool(
    'capability_search',
    {
      description:
        'Search installable capabilities (presets + skill registries) when the current ' +
        'task needs an ability you do not have. Install via capability_install (human approval required).',
      inputSchema: z.object({ query: z.string().min(1).max(200) }),
    },
    async ({ query }) => {
      const candidates = await searchCapabilities(query, {
        searchRegistries: (q) => searchSkills(fetch, q),
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(candidates) }] };
    },
  );

  // Tool 12: capability_install — two-phase: file approval (guard report in the
  // body), then execute once the human approves. An agent cannot grant itself
  // authority (ADR-53).
  server.registerTool(
    'capability_install',
    {
      description:
        'Install a capability. First call with install_ref files a human approval ' +
        '(guard scan included) and returns approval_id. After the human approves, ' +
        'call again with BOTH install_ref and approval_id to execute.',
      inputSchema: z.object({
        install_ref: z.string().min(1).max(300),
        approval_id: z.string().regex(UUID_V4).optional(),
        scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
        principal: z.string().max(128).default('mcp-agent'),
      }),
    },
    async ({ install_ref, approval_id, scope_id, principal }) => {
      const deps = makeAcquisitionDeps();
      if (approval_id === undefined) {
        const filed = await requestInstall(approvals, deps, scope_id, principal, install_ref);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ...filed,
                status: 'pending',
                next: 'await human approval, then re-call with approval_id',
              }),
            },
          ],
        };
      }
      const result = await executeInstall(pool, approvals, deps, approval_id, install_ref, principal);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    },
  );

  // Tool 13: browser (conditional, like execute_bash) — category-resolved
  // implementation inside the docker backend; host browsers are never driven.
  if (process.env['MEMEX_BROWSER_ENABLED'] === 'true') {
    server.registerTool(
      'browser',
      {
        description:
          'Controlled browser action inside an isolated container: navigate | read | ' +
          'fill | click | screenshot. The implementation is the bound `browser` capability.',
        inputSchema: z.object({
          op: z.enum(['navigate', 'read', 'fill', 'click', 'screenshot']),
          url: z.string().max(2000).optional(),
          selector: z.string().max(500).optional(),
          text: z.string().max(4000).optional(),
          scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
          predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
        }),
      },
      async ({ op, url, selector, text, scope_id, predecessor_hash }) => {
        const bindings = await resolveBindings(pool).catch(() => ({}) as Record<string, string>);
        const impl = bindings['browser'];
        if (impl === undefined) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'no browser implementation bound — memex capability bind browser <impl>',
              },
            ],
          };
        }
        let args: string[];
        try {
          args = buildBrowserRunArgs(impl, {
            op,
            ...(url !== undefined ? { url } : {}),
            ...(selector !== undefined ? { selector } : {}),
            ...(text !== undefined ? { text } : {}),
          });
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
          };
        }

        // Vault injection happens at THIS boundary only (ADR-53): placeholders
        // in the container command resolve to plaintext here, never earlier.
        const last = args[args.length - 1]!;
        if (last.includes('{{vault:')) {
          const injected = await injectSecrets(pool, last);
          if (injected.missing.length > 0) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: `vault secrets missing/shredded: ${injected.missing.join(', ')}`,
                },
              ],
            };
          }
          args[args.length - 1] = injected.resolved;
        }

        try {
          const execFileAsync = promisify(execFile);
          const { stdout } = await execFileAsync('docker', args, {
            timeout: 60000,
            maxBuffer: 8 * 1024 * 1024,
          });

          // Screenshots are artifacts (ADR-52 first mandatory producer).
          let artifactHash: string | undefined;
          if (op === 'screenshot') {
            const image = Buffer.from(stdout.trim(), 'base64');
            const saved = await saveArtifact(pool, {
              scopeId: scope_id,
              content: image,
              kind: 'image',
              mediaType: 'image/png',
              label: `browser screenshot ${new Date().toISOString()}`,
            });
            artifactHash = saved.contentHash;
          }

          await occWrite(pool, {
            scopeId: scope_id,
            entityId: randomUUID(),
            predecessorHash: predecessor_hash,
            eventType: 'memory_updated',
            // redaction direction: the ledger gets the op, never fill VALUES
            payload: {
              kind: 'memex::browser::op',
              op,
              implementation: impl,
              ...(artifactHash !== undefined ? { artifact_hash: artifactHash } : {}),
            },
          }).catch(() => {
            /* trail mark best-effort */
          });

          const resultText =
            op === 'screenshot' ? JSON.stringify({ artifact_hash: artifactHash }) : stdout.slice(0, 16384);
          return { content: [{ type: 'text' as const, text: resultText }] };
        } catch (err) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `browser backend failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
          };
        }
      },
    );
  }

  return server;
}

/**
 * Acquisition deps over the shared skills client. v1 executes `skill:` refs
 * end-to-end; `preset:` refs return operator guidance (presets may need env
 * prompts / OAuth that only the interactive CLI can drive).
 */
function makeAcquisitionDeps(): {
  scanCandidate(ref: string): Promise<{ findings: number; report: string }>;
  performInstall(ref: string): Promise<{ location: string }>;
} {
  const parseSkillRef = (ref: string): { registry: (typeof REGISTRIES)[number]; id: string } => {
    const m = /^skill:([^:]+):(.+)$/.exec(ref);
    const registry = m ? REGISTRIES.find((r) => r.name === m[1]) : undefined;
    if (!m || !registry) {
      throw new Error(`unsupported install_ref '${ref}' — expected skill:<registry>:<id> or preset:<name>`);
    }
    return { registry, id: m[2]! };
  };
  return {
    async scanCandidate(ref) {
      if (ref.startsWith('preset:')) {
        return {
          findings: 0,
          report: 'preset install — runs via operator CLI (memex capability install), no remote content to scan',
        };
      }
      const { registry, id } = parseSkillRef(ref);
      const res = await fetch(registry.downloadUrl(id), { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`download failed: ${res.status} from ${registry.name}`);
      const findings = scanSkillContent(await res.text());
      return { findings: findings.length, report: formatGuardReport(findings) };
    },
    async performInstall(ref) {
      if (ref.startsWith('preset:')) {
        return { location: `operator action required: memex capability install ${ref.slice('preset:'.length)}` };
      }
      const { registry, id } = parseSkillRef(ref);
      // installSkill re-downloads + re-scans (TOCTOU guard); confirmed=true is
      // legitimate here because the human approved WITH the scan report in hand.
      const outcome = await installSkill(fetch, registry, id, id, join(profileDir(), 'skills'), true);
      return { location: outcome.dir };
    },
  };
}

// Re-export ZERO_HASH for convenience (used in tests)
export { ZERO_HASH };
