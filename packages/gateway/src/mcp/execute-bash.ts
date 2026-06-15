/**
 * runExecuteBash — the single execute_bash implementation, shared by both
 * surfaces that run host commands:
 *   - the MCP-over-HTTP tool (buildMcpServer, external agents)
 *   - the in-process Pi tool (MemexTerminal, ADR-57 D-5)
 *
 * Extracting it here kills the "two tool implementations drift apart" risk
 * called out in ADR-57's 後果. Containment, CommandGate gating, fail-closed
 * docker, and the blocked-attempt/result trail writes all live in one place.
 *
 * @see packages/gateway/src/mcp/tools/exec.ts — MCP tool registration
 * @see docs/adr/0066-adr57-memexterminal-pi-embed.md D-5
 * @see ADR 47 D-4 — backend decides containment; fail-closed on docker unreachable
 */
import { randomUUID } from 'crypto';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import type { Pool } from 'pg';
import { occWrite, checkCommand, projectFromCwd, recordScopeProject } from '@graph/shared';
import {
  buildDockerRunArgs,
  approvalRequiredForBackend,
  resolveExecBackend,
} from '../security/exec-backend.js';

// Secrets that must never reach an execute_bash subprocess. With the vault KEK,
// container/host code could unwrap every stored credential.
const SCRUB_KEYS = new Set([
  'DATABASE_URL', 'LLM_API_KEY', 'GRAPH_RUNTIME_SECRET',
  'TELEGRAM_BOT_TOKEN', 'DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY',
  'MEMEX_VAULT_KEK', 'MEMEX_GATEWAY_TOKEN',
]);

function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!SCRUB_KEYS.has(k)) out[k] = v;
  }
  return out;
}

export interface ExecuteBashParams {
  command: string;
  scopeId: string;
  predecessorHash: string;
  /** Local-backend working dir; defaults to EXECUTE_BASH_CWD env ?? tmpdir(). */
  cwd?: string;
}

export interface ExecuteBashResult {
  isError: boolean;
  /** JSON-encoded {stdout,stderr,exit_code,backend} on success, or a plain message on block/error. */
  text: string;
}

/**
 * Run one host command under containment + CommandGate, writing the attempt
 * (blocked) or the result (ran) to the causal ledger. Pure logic — no MCP/Pi
 * shape coupling; callers wrap the {isError,text} into their own envelope.
 */
export async function runExecuteBash(
  pool: Pool,
  { command, scopeId, predecessorHash, cwd }: ExecuteBashParams,
): Promise<ExecuteBashResult> {
  const verdict = checkCommand(command);
  const entityId = randomUUID();
  const workdir = cwd ?? process.env['EXECUTE_BASH_CWD'] ?? tmpdir();

  // ADR-47 D-4: the backend decides containment. Fail-closed when docker is
  // requested but unreachable — never silently run on the host, because the
  // docker backend bypasses dangerous-pattern approval (contained commands
  // can't reach the host; host exec with that bypass would be catastrophic).
  const backend = await resolveExecBackend();
  if (backend === null) {
    return {
      isError: true,
      text:
        'BLOCKED: EXEC_BACKEND=docker but docker is unreachable. Refusing to fall ' +
        'back to host execution (fail-closed). Start docker or unset EXEC_BACKEND.',
    };
  }

  const gate = approvalRequiredForBackend(backend, verdict);
  // (!verdict.allowed narrows the union; gate flags are only set when blocked.)
  if (!verdict.allowed && (gate.blocked || gate.requiresApproval)) {
    // Blocked-attempt audit — failures are first-class graph events.
    try {
      await occWrite(pool, {
        scopeId,
        entityId,
        predecessorHash,
        eventType: 'memory_updated',
        payload: { command, status: 'blocked', tier: verdict.tier, reason: verdict.reason, backend },
      });
    } catch {
      // best-effort; must not suppress the block response
    }
    const msg = gate.blocked
      ? `BLOCKED (hardline): ${verdict.reason}. Cannot execute.`
      : `BLOCKED (requires approval): ${verdict.reason}. Use the graph runtime console to approve.`;
    return { isError: true, text: msg };
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
        ...(process.env['EXECUTE_BASH_IMAGE'] ? { image: process.env['EXECUTE_BASH_IMAGE'] } : {}),
      });
      ({ stdout, stderr } = await execFileAsync('docker', args, {
        timeout: 35000, // container spin-up + command
        maxBuffer: 512 * 1024,
      }));
    } else {
      // CONSOLE-REDESIGN §11.1: the local working folder is this scope's
      // project. Record it (first-write-wins) so the Now universe clusters
      // and the Workspace page groups by it. tmp/ephemeral cwd → no project.
      const project = projectFromCwd(workdir);
      if (project) await recordScopeProject(pool, scopeId, project);
      const execAsync = promisify(exec);
      ({ stdout, stderr } = await execAsync(command, {
        timeout: 30000,
        maxBuffer: 512 * 1024,
        cwd: workdir,
        env: scrubEnv(process.env),
      }));
    }
    await occWrite(pool, {
      scopeId,
      entityId,
      predecessorHash,
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
    return { isError: false, text: JSON.stringify({ stdout, stderr, exit_code: 0, backend }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    if (typeof e.code === 'number') {
      // Non-zero exit — record result, not an error.
      try {
        await occWrite(pool, {
          scopeId,
          entityId,
          predecessorHash,
          eventType: 'memory_updated',
          payload: { command, stdout: e.stdout ?? '', stderr: e.stderr ?? '', exit_code: e.code, backend },
        });
      } catch {
        // best-effort
      }
      return {
        isError: false,
        text: JSON.stringify({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', exit_code: e.code, backend }),
      };
    }
    // Timeout or maxBuffer exceeded.
    return { isError: true, text: JSON.stringify({ error: e.message ?? String(err), backend }) };
  }
}
