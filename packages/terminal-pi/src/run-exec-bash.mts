/**
 * Build-out line #4 (ADR-57 D-5) — bind the REAL execute_bash into Pi. The Pi
 * tool wraps gateway's shared runExecuteBash (the SAME function the MCP-over-HTTP
 * tool calls — no second implementation, ADR-57 後果). The model sees only
 * { command }; scopeId + predecessor hash are supplied by the terminal closure,
 * because the graph (not the model) owns the scope (C3, ADR-57 D-3). A tool_call
 * approval hook gates it: benign commands run, dangerous ones are blocked and a
 * real ApprovalService row + audit lands (same gate proven in run-approval.mts).
 *
 * PASS: a benign command runs end-to-end through runExecuteBash and its result
 * (stdout + exit_code 0) lands in the causal ledger for this scope.
 *
 * Run: `npx tsx src/run-exec-bash.mts` from packages/terminal-pi.
 */
import { readFileSync } from 'node:fs';
import { Type } from 'typebox';
import pg from 'pg';
import { checkCommand } from '@graph/shared';
import { nestScope } from '@graph/control-plane/nesting';
import { ApprovalService } from '@graph/gateway/security/approval';
import { runExecuteBash } from '@graph/gateway/mcp/execute-bash';
import {
  defineTool,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { buildSessionWithCoreBrain } from './provider-bridge.js';

for (const root of ['.env', '../../.env', 'D:/Repo/graph-enginerring/.env']) {
  try {
    for (const line of readFileSync(root, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  } catch {
    /* next */
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const approvals = new ApprovalService(pool);

/** The scope's current tip = predecessor for the next append. */
async function tip(scopeId: string): Promise<string> {
  const { rows } = await pool.query<{ version_hash: string }>(
    'SELECT version_hash FROM execution_event_log WHERE scope_id = $1 ORDER BY id DESC LIMIT 1',
    [scopeId],
  );
  return rows[0]!.version_hash;
}

const BENIGN = 'echo hello-from-pi';

async function main() {
  const { scopeId } = await nestScope(pool, `session:terminal-pi:execbash:${Date.now()}`);
  console.log('[exec] scope', scopeId.slice(0, 8));

  // The Pi tool: model supplies only { command }; the terminal owns the scope.
  const executeBash = defineTool({
    name: 'execute_bash',
    label: 'Execute Bash',
    description: 'Run a bash command on the host and return its output. Use this to run the requested command.',
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params) {
      const command = (params as { command: string }).command;
      const result = await runExecuteBash(pool, {
        command,
        scopeId,
        predecessorHash: await tip(scopeId),
      });
      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: { command },
        isError: result.isError,
      };
    },
  });

  // Approval gate (same double-write pattern as run-approval.mts): file a real
  // ApprovalService request, decide (CommandGate policy headless; ctx.ui.confirm
  // in a TUI), block on deny.
  const gate: ExtensionFactory = (pi) => {
    pi.on('tool_call', async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
      if (event.toolName !== 'execute_bash') return undefined;
      const command = String((event.input as { command?: unknown }).command ?? '');
      const verdict = checkCommand(command);
      const approvalId = await approvals.request(scopeId, 'mcp-agent', command);
      const approved = ctx.hasUI ? await ctx.ui.confirm('Approve command?', command) : verdict.allowed;
      await approvals.decide(approvalId, approved, 'once');
      console.log(`[exec] tool_call ${command} -> verdict=${verdict.allowed ? 'allow' : 'block'} decided=${approved ? 'approve' : 'deny'}`);
      if (!approved) return { block: true, reason: `denied by approval ${approvalId.slice(0, 8)}` };
      return undefined;
    });
  };

  const { session } = await buildSessionWithCoreBrain({ customTools: [executeBash], extensionFactories: [gate] });

  // Checklist #3 — pi's raw built-ins must be suppressed. getActiveToolNames()
  // is the ENABLED set offered to the model (getToolDefinition is the
  // definition-first registry, which keeps bash defined-but-disabled — that's
  // the enabled≠registered distinction the spike flagged). Only Core's
  // containerized execute_bash should be reachable; raw bash/read/edit/write
  // (host escape, no CommandGate, no scrubEnv, no ledger) must be gone.
  const active = session.getActiveToolNames();
  const RAW_BUILTINS = ['bash', 'read', 'edit', 'write'];
  const rawExposed = RAW_BUILTINS.filter((t) => active.includes(t));
  const execBashExposed = active.includes('execute_bash');
  console.log('[exec] active tools:', JSON.stringify(active), '| raw builtins exposed:', JSON.stringify(rawExposed));

  await session.prompt(`Use the execute_bash tool to run this exact command: ${BENIGN}`);
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 100));

  // Verify the real result landed in the ledger (same shared runExecuteBash the
  // MCP tool writes through).
  const { rows } = await pool.query<{ payload: string }>(
    `SELECT payload FROM execution_event_log
       WHERE scope_id = $1 AND payload::jsonb->>'command' = $2
       ORDER BY id DESC LIMIT 1`,
    [scopeId, BENIGN],
  );
  const payload = rows[0] ? (JSON.parse(rows[0].payload) as { stdout?: string; exit_code?: number; backend?: string }) : undefined;
  console.log('[exec] ledger payload:', JSON.stringify(payload));

  const ranOk =
    payload !== undefined &&
    payload.exit_code === 0 &&
    (payload.stdout ?? '').includes('hello-from-pi');
  const suppressionOk = execBashExposed && rawExposed.length === 0;
  const ok = ranOk && suppressionOk;
  console.log(ok
    ? `[exec] PASS — execute_bash bound (ran via shared runExecuteBash, ledger backend=${payload?.backend}); raw pi builtins suppressed (active=[${active.join(', ')}])`
    : `[exec] FAIL — ranOk=${ranOk} suppressionOk=${suppressionOk} (execBashExposed=${execBashExposed}, rawExposed=[${rawExposed.join(', ')}])`);
  await pool.end();
  process.exit(ok ? 0 : 1);
}

void main();
