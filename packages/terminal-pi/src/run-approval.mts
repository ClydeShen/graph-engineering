/**
 * Build-out line #3 — approval (ADR-57 D-4). A gated tool call is intercepted at
 * the tool_call hook: in-stream UX via ctx.ui.confirm (TUI), AND a double-write
 * to the real ApprovalService (approval_request row + memex::security::approval_*
 * audit events). A denied decision blocks the tool. The audit row is the SSOT;
 * the local confirm is the UX fast path.
 *
 * Headless proof: with no TUI, the decision falls back to CommandGate policy
 * (deny dangerous). The ctx.ui.confirm path is exercised in real TUI use.
 *
 * Run: `npx tsx src/run-approval.mts` from packages/terminal-pi.
 */
import { readFileSync } from 'node:fs';
import { Type } from 'typebox';
import pg from 'pg';
import { checkCommand } from '@graph/shared';
import { nestScope } from '@graph/control-plane/nesting';
import { ApprovalService } from '@graph/gateway/security/approval';
import { defineTool, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
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

const DANGEROUS = 'rm -rf /tmp/memex-approval-probe';
let executed = false;

// Gated stand-in for execute_bash.
const shellExec = defineTool({
  name: 'shell_exec',
  label: 'Shell Exec',
  description: 'Run a shell command on the host. Use this to execute the requested command.',
  parameters: Type.Object({ command: Type.String() }),
  async execute(_id, params) {
    executed = true;
    return { content: [{ type: 'text', text: `ran: ${(params as { command: string }).command}` }] };
  },
});

async function main() {
  const { scopeId } = await nestScope(pool, `session:terminal-pi:approval:${Date.now()}`);
  console.log('[approval] scope', scopeId.slice(0, 8));

  const gate: ExtensionFactory = (pi) => {
    pi.on('tool_call', async (event: { toolName: string; input: Record<string, unknown> }, ctx: { hasUI: boolean; ui: { confirm(t: string, m: string): Promise<boolean> } }) => {
      if (event.toolName !== 'shell_exec') return;
      const command = String(event.input.command ?? '');
      const verdict = checkCommand(command);

      // Double-write #1: file a real approval (row + memex::security::approval_requested audit).
      const approvalId = await approvals.request(scopeId, 'mcp-agent', command);

      // Decision: TUI confirm when available, else CommandGate policy (deny dangerous).
      const approved = ctx.hasUI
        ? await ctx.ui.confirm('Approve command?', command)
        : verdict.allowed;

      // Double-write #2: record the human decision (approval_granted / approval_denied audit).
      await approvals.decide(approvalId, approved, 'once');
      console.log(`[approval] tool_call ${command} -> verdict=${verdict.allowed ? 'allow' : 'block'} decided=${approved ? 'approve' : 'deny'} id=${approvalId.slice(0, 8)}`);

      if (!approved) return { block: true, reason: `denied by approval ${approvalId.slice(0, 8)}: ${verdict.reason ?? 'human denied'}` };
      return undefined;
    });
  };

  const { session } = await buildSessionWithCoreBrain({ customTools: [shellExec], extensionFactories: [gate] });
  await session.prompt(`Use the shell_exec tool to run this exact command: ${DANGEROUS}`);
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 100));

  // Verify the real audit trail.
  const reqRow = await pool.query<{ status: string }>(
    `SELECT status FROM approval_request WHERE scope_id = $1 AND command = $2 ORDER BY requested_at DESC LIMIT 1`,
    [scopeId, DANGEROUS],
  );
  const audit = await pool.query<{ kind: string }>(
    `SELECT payload::jsonb->>'kind' AS kind FROM execution_event_log
       WHERE scope_id = $1 AND payload::jsonb->>'kind' LIKE 'memex::security::approval_%'`,
    [scopeId],
  );
  const kinds = audit.rows.map((r) => r.kind);
  console.log('[approval] executed?', executed, '| approval_request status:', reqRow.rows[0]?.status, '| audit kinds:', JSON.stringify(kinds));

  const ok =
    executed === false &&
    reqRow.rows[0]?.status === 'denied' &&
    kinds.includes('memex::security::approval_requested') &&
    kinds.includes('memex::security::approval_denied');
  console.log(ok
    ? '[approval] PASS — gated tool blocked; ApprovalService double-write landed (request + denied audit)'
    : '[approval] FAIL');
  await pool.end();
  process.exit(ok ? 0 : 1);
}

void main();
