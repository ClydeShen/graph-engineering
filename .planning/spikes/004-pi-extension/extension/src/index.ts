/**
 * Spike 004: Pi Extension entry point
 *
 * Validates:
 * 1. Pi ExtensionAPI can register spawn_task / complete_task as Pi tools
 * 2. session_start event wires up shadow adapter activation
 * 3. /fork command triggers runtime.fork() + InMemoryShadowAdapter swap
 * 4. tool_call hook intercepts dangerous operations in rehearsal mode
 *
 * In production this imports from @earendil-works/pi-coding-agent.
 * In this spike it uses the local type shim.
 */

import type { ExtensionAPI, ExtensionContext } from './pi-types.shim.js';
import { InMemoryShadowAdapter } from '../../../003-shadow-adapter/scripts/shadow-adapter.js';

// ---------------------------------------------------------------------------
// Shadow adapter state — lives for the lifetime of a rehearsal session.
// Activated by /fork, destroyed on session end or /fork-end.
// ---------------------------------------------------------------------------

let activeShadow: InMemoryShadowAdapter | null = null;

export function isRehearsalActive(): boolean {
  return activeShadow !== null;
}

export function getShadow(): InMemoryShadowAdapter | null {
  return activeShadow;
}

// ---------------------------------------------------------------------------
// Graph Runtime tool definitions (what Pi exposes to the agent)
// ---------------------------------------------------------------------------

const GRAPH_URL = process.env['GRAPH_RUNTIME_URL'] ?? 'http://localhost:4000';

async function callMcp(tool: string, args: Record<string, unknown>, shadow: InMemoryShadowAdapter | null) {
  // In rehearsal mode: writes go to shadow, reads still hit real graph
  // In interactive mode: all calls go to real graph MCP endpoint
  const mode = shadow ? 'rehearsal' : 'interactive';
  return {
    mode,
    tool,
    args,
    endpoint: `${GRAPH_URL}/mcp`,
    shadow_entries: shadow?.getEntries().length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Extension factory — default export called by Pi on load
// ---------------------------------------------------------------------------

export default function graphRuntimeExtension(pi: ExtensionAPI) {

  // --- session_start: announce mode ---
  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    const mode = isRehearsalActive() ? '🟡 REHEARSAL' : '🟢 INTERACTIVE';
    ctx.ui.notify(`Graph Runtime connected [${mode}] → ${GRAPH_URL}`, 'info');
  });

  // --- tool_call: guard destructive ops in rehearsal mode ---
  pi.on('tool_call', async (event, ctx: ExtensionContext) => {
    if (!isRehearsalActive()) return;

    // In rehearsal, block bash commands that could affect the real filesystem
    if (event.toolName === 'bash') {
      const cmd = (event.input['command'] as string) ?? '';
      if (cmd.match(/\b(rm|git push|git commit|psql)\b/)) {
        const ok = await ctx.ui.confirm(
          'Rehearsal guard',
          `"${cmd}" affects the real world. Allow in rehearsal mode?`,
        );
        if (!ok) return { block: true, reason: 'Blocked by Graph Runtime rehearsal guard' };
      }
    }
  });

  // --- spawn_task tool ---
  pi.registerTool({
    name: 'spawn_task',
    label: 'Spawn Task',
    description: 'Spawn a new task node in the execution graph. In rehearsal mode, writes to shadow only.',
    parameters: {
      type: 'object',
      properties: {
        scope_id: { type: 'string', description: 'Scope UUID' },
        title: { type: 'string', description: 'Task title' },
        payload: { type: 'object', description: 'Task payload' },
      },
      required: ['scope_id', 'title'],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await callMcp('spawn_task', params as Record<string, unknown>, activeShadow);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // --- complete_task tool ---
  pi.registerTool({
    name: 'complete_task',
    label: 'Complete Task',
    description: 'Mark a task as complete in the execution graph.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string', description: 'Entity UUID to complete' },
        scope_id: { type: 'string', description: 'Scope UUID' },
        result: { type: 'object', description: 'Completion result payload' },
      },
      required: ['entity_id', 'scope_id'],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await callMcp('complete_task', params as Record<string, unknown>, activeShadow);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // --- /fork command: enter rehearsal mode ---
  pi.registerCommand('fork', {
    description: 'Enter rehearsal mode: fork from entry-id, shadow writes, read-through PostgreSQL',
    handler: async (args: string, ctx: ExtensionContext) => {
      const entryId = args.trim();
      if (!entryId) {
        ctx.ui.notify('Usage: /fork <entry-id>', 'warn');
        return;
      }
      if (activeShadow) {
        ctx.ui.notify('Already in rehearsal mode. Run /fork-end to exit first.', 'warn');
        return;
      }

      // Activate shadow adapter (swaps write path)
      // In production: realPool comes from the extension's service registry
      const mockRealPool = { query: async () => ({ rows: [], rowCount: 0 }) };
      activeShadow = new InMemoryShadowAdapter(mockRealPool);

      // Pi's fork creates a new session branching from entryId
      await ctx.runtime.fork(entryId);

      ctx.ui.notify(
        `🟡 Rehearsal mode ACTIVE — forked from ${entryId}. All writes → shadow only.`,
        'info',
      );
    },
  });

  // --- /fork-end command: destroy shadow, return to interactive ---
  pi.registerCommand('fork-end', {
    description: 'Exit rehearsal mode: destroy shadow entries (阅后即焚)',
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!activeShadow) {
        ctx.ui.notify('Not in rehearsal mode.', 'warn');
        return;
      }
      const count = activeShadow.getEntries().length;
      activeShadow.clear();
      activeShadow = null;
      ctx.ui.notify(
        `🟢 Rehearsal ended. ${count} shadow entries destroyed (阅后即焚).`,
        'info',
      );
    },
  });
}
