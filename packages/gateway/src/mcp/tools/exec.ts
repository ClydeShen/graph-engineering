/**
 * execute_bash MCP tool — env-gated (EXECUTE_BASH_ENABLED=true). The handler is
 * the single shared implementation (`runExecuteBash`) also bound in-process by
 * the Pi terminal (ADR-57 D-5): one impl, two surfaces.
 */
import { z } from 'zod';
import type { Pool } from 'pg';
import { tmpdir } from 'os';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runExecuteBash } from '../execute-bash.js';
import { UUID_V4, HASH_HEX64, type McpToolDef, type McpToolFactory } from './types.js';

const ExecuteBashSchema = z.object({
  command: z.string().min(1).max(4096),
  scope_id: z.string().regex(UUID_V4, 'scope_id must be UUID v4'),
  predecessor_hash: z.string().regex(HASH_HEX64, 'predecessor_hash must be 64-char hex'),
});

async function handleExecuteBash(
  pool: Pool,
  cwd: string,
  args: z.infer<typeof ExecuteBashSchema>,
): Promise<CallToolResult> {
  const { command, scope_id, predecessor_hash } = args;
  // Single implementation shared with the in-process Pi tool (ADR-57 D-5).
  const result = await runExecuteBash(pool, {
    command,
    scopeId: scope_id,
    predecessorHash: predecessor_hash,
    cwd,
  });
  return {
    ...(result.isError ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: result.text }],
  };
}

/** Returns null unless EXECUTE_BASH_ENABLED=true (preserving registry order). */
export const executeBashTool: McpToolFactory = (pool): McpToolDef | null => {
  if (process.env['EXECUTE_BASH_ENABLED'] !== 'true') return null;
  const cwd = process.env['EXECUTE_BASH_CWD'] ?? tmpdir();
  return {
    name: 'execute_bash',
    description:
      'Execute a bash command on the host. Gated by CommandGate — hardline and dangerous ' +
      'commands are blocked. Requires EXECUTE_BASH_ENABLED=true.',
    inputSchema: ExecuteBashSchema,
    handler: (args) => handleExecuteBash(pool, cwd, args as z.infer<typeof ExecuteBashSchema>),
  };
};
