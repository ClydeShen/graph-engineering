/**
 * Spike 004 (corrected): Pi Extension entry point
 *
 * API corrections from https://pi.dev/docs/latest/extensions:
 * - ctx in event handlers: ExtensionContext (NO fork, NO runtime)
 * - ctx in command handlers: ExtensionCommandContext (HAS ctx.fork() directly)
 * - session_before_fork event: hook into Pi's own built-in /fork command
 *
 * Two-path fork activation:
 * A) User runs Pi's native /fork <entryId> → session_before_fork event fires → shadow activates
 * B) Our /fork-ext <entryId> command → ctx.fork(entryId) + shadow activates (explicit override)
 *
 * /fork-end command → shadow.clear() (阅后即焚)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from './pi-types.shim.js';
import { InMemoryShadowAdapter } from '../../../003-shadow-adapter/scripts/shadow-adapter.js';

// ---------------------------------------------------------------------------
// Shadow adapter state — module singleton for the Pi extension session
// ---------------------------------------------------------------------------

let activeShadow: InMemoryShadowAdapter | null = null;

export function isRehearsalActive(): boolean {
  return activeShadow !== null;
}

export function getShadow(): InMemoryShadowAdapter | null {
  return activeShadow;
}

function activateShadow(entryId: string, ctx: ExtensionContext): void {
  if (activeShadow) return; // guard re-entry
  const mockRealPool = { query: async () => ({ rows: [], rowCount: 0 }) };
  activeShadow = new InMemoryShadowAdapter(mockRealPool);
  ctx.ui.notify(
    `🟡 Rehearsal mode ACTIVE — forked from ${entryId}. Writes → shadow only.`,
    'info',
  );
}

// ---------------------------------------------------------------------------
// Graph Runtime URL
// ---------------------------------------------------------------------------

const GRAPH_URL = process.env['GRAPH_RUNTIME_URL'] ?? 'http://localhost:4000';

async function callMcp(tool: string, args: Record<string, unknown>) {
  return {
    mode: activeShadow ? 'rehearsal' : 'interactive',
    tool,
    args,
    endpoint: `${GRAPH_URL}/mcp`,
    shadow_entries: activeShadow?.getEntries().length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function graphRuntimeExtension(pi: ExtensionAPI) {

  // --- session_start: announce mode ---
  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    const mode = isRehearsalActive() ? '🟡 REHEARSAL' : '🟢 INTERACTIVE';
    ctx.ui.notify(`Graph Runtime [${mode}] → ${GRAPH_URL}`, 'info');
  });

  // --- session_before_fork: hook into Pi's OWN /fork command ---
  // When user runs Pi's built-in /fork <entryId>, we activate shadow BEFORE the fork
  pi.on('session_before_fork', async (event, ctx: ExtensionContext) => {
    activateShadow(event.entryId, ctx);
  });

  // --- tool_call: guard destructive ops in rehearsal ---
  pi.on('tool_call', async (event, ctx: ExtensionContext) => {
    if (!isRehearsalActive()) return;
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
    description: 'Spawn a task in the execution graph. In rehearsal mode, writes to shadow only.',
    parameters: {
      type: 'object',
      properties: {
        scope_id: { type: 'string' },
        title: { type: 'string' },
        payload: { type: 'object' },
      },
      required: ['scope_id', 'title'],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await callMcp('spawn_task', params as Record<string, unknown>);
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
    description: 'Mark a task complete in the execution graph.',
    parameters: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        scope_id: { type: 'string' },
        result: { type: 'object' },
      },
      required: ['entity_id', 'scope_id'],
    },
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const result = await callMcp('complete_task', params as Record<string, unknown>);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });

  // --- /fork-ext command: explicit rehearsal activation (alternative to Pi's /fork) ---
  // ctx here is ExtensionCommandContext — ctx.fork() is available directly
  pi.registerCommand('fork-ext', {
    description: 'Activate rehearsal mode: fork from entry-id + shadow writes',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const entryId = args.trim();
      if (!entryId) {
        ctx.ui.notify('Usage: /fork-ext <entry-id>', 'warn');
        return;
      }
      if (activeShadow) {
        ctx.ui.notify('Already in rehearsal. Run /fork-end to exit first.', 'warn');
        return;
      }
      // ctx.fork() is on ExtensionCommandContext — not ctx.runtime.fork()
      await ctx.fork(entryId);
      activateShadow(entryId, ctx);
    },
  });

  // --- /fork-end command: destroy shadow (阅后即焚) ---
  pi.registerCommand('fork-end', {
    description: 'Exit rehearsal mode: destroy shadow entries (阅后即焚)',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
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
