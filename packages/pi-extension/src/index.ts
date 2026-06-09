/**
 * Pi extension entry point for the Graph Runtime.
 *
 * Two-path fork activation:
 * A) User runs Pi's native /fork <entryId> → session_before_fork fires → shadow activates
 * B) Our /fork-ext <entryId> command → ctx.fork(entryId) + shadow activates
 *
 * /fork-end → shadow.clear() (阅后即焚)
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from './pi-types.shim.js';
import { InMemoryShadowAdapter } from '@graph/shared';

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
  // No-op pool: the extension does not hold a pg.Pool; shadow captures write intent only.
  activeShadow = new InMemoryShadowAdapter({ query: async () => ({ rows: [], rowCount: 0 }) });
  ctx.ui.notify(
    `[REHEARSAL] mode ACTIVE — forked from ${entryId}. Writes → shadow only.`,
    'info',
  );
}

// ---------------------------------------------------------------------------
// Graph Runtime URL
// ---------------------------------------------------------------------------

const GRAPH_URL = process.env['GRAPH_RUNTIME_URL'] ?? 'http://localhost:4000';

// TODO Phase 5: wire real fetch — currently returns mode/args for Phase 4 validation
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

  pi.on('session_start', async (_event, ctx: ExtensionContext) => {
    const mode = isRehearsalActive() ? '[REHEARSAL]' : '[INTERACTIVE]';
    ctx.ui.notify(`Graph Runtime ${mode} → ${GRAPH_URL}`, 'info');
  });

  // Hook into Pi's own /fork command — activates shadow BEFORE the fork
  pi.on('session_before_fork', async (event, ctx: ExtensionContext) => {
    activateShadow(event.entryId, ctx);
  });

  // Guard destructive bash commands in rehearsal mode
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

  // /fork-ext: explicit rehearsal activation (alternative to Pi's built-in /fork)
  // ctx here is ExtensionCommandContext — ctx.fork() is available directly
  pi.registerCommand('fork-ext', {
    description: 'Activate rehearsal mode: fork from entry-id + shadow writes',
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const entryId = args.trim();
      if (!entryId) {
        ctx.ui.notify('Usage: /fork-ext <entry-id>', 'warning');
        return;
      }
      if (activeShadow) {
        ctx.ui.notify('Already in rehearsal. Run /fork-end to exit first.', 'warning');
        return;
      }
      await ctx.fork(entryId);
      activateShadow(entryId, ctx);
    },
  });

  // /fork-end: destroy shadow (阅后即焚)
  pi.registerCommand('fork-end', {
    description: 'Exit rehearsal mode: destroy shadow entries (阅后即焚)',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (!activeShadow) {
        ctx.ui.notify('Not in rehearsal mode.', 'warning');
        return;
      }
      const count = activeShadow.getEntries().length;
      activeShadow.clear();
      activeShadow = null;
      ctx.ui.notify(
        `[INTERACTIVE] Rehearsal ended. ${count} shadow entries destroyed (阅后即焚).`,
        'info',
      );
    },
  });
}
