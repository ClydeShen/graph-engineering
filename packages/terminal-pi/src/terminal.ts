/**
 * MemexTerminal (Pi-embed) — the assembled agentic terminal (ADR-57).
 *
 * This is the real surface the proof scripts (run-*.mts) prototyped line by line.
 * It wires the five lines into one reusable runtime:
 *   - brain   = Core's onboarded provider via config-share (provider-bridge, D-2)
 *   - memory  = the graph is working memory; C3 injects the projection at
 *               before_agent_start and flushes the turn at agent_end (D-3)
 *   - tools   = in-process Core tools (execute_bash via shared runExecuteBash …)
 *   - approval= tool_call hook double-writes ApprovalService and blocks (D-4)
 *   - isolation = hermetic embed, no external ~/.pi resources (EMBED_RESOURCE_ISOLATION)
 *
 * createMemexTerminalRuntime() returns a Pi AgentSessionRuntime that two surfaces
 * drive: the interactive Pi TUI (InteractiveMode — DRY, we don't build our own
 * loop/approval/TUI) and the scriptable single-turn path (index.ts -m).
 *
 * @see docs/adr/0066-adr57-memexterminal-pi-embed.md
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import type { Pool } from 'pg';
import { occWrite, checkCommand } from '@graph/shared';
import { processAgentTurn } from '@graph/gateway/process-agent-turn';
import { loadConversationHistory, conversationMemoryBlock } from '@graph/gateway/conversation';
import { ApprovalService } from '@graph/gateway/security/approval';
import { runExecuteBash } from '@graph/gateway/mcp/execute-bash';
import { upsertCronJob } from '@graph/gateway-bot/cron';
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  defineTool,
  type AgentSessionRuntime,
  type ToolDefinition,
  type ExtensionFactory,
  type ToolCallEvent,
  type ToolCallEventResult,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { buildCoreModelRegistry, EMBED_RESOURCE_ISOLATION } from './provider-bridge.js';

/** Context-projection budget for the C3 injection (mirrors the gateway default). */
const WMAX = 4000;

/**
 * Agentic system role for MemexTerminal. Distinct from the channel conversation
 * core's CONVERSATION_SYSTEM_ROLE (ADR-54), which is deliberately NON-agentic
 * ("no ability to run tools") for the channel trust boundary. The terminal is
 * the agentic surface (ADR-57 per-surface law): it CAN run tools. The
 * no-fabrication discipline carries over.
 */
export const MEMEX_TERMINAL_SYSTEM_ROLE =
  'You are the memex, an agentic terminal assistant backed by a persistent graph ' +
  'memory. You have tools (e.g. execute_bash to run shell commands) — use them to ' +
  'accomplish the task rather than guessing. Some commands require human approval ' +
  'before they run; if one is denied, report that and stop, do not work around it. ' +
  'Never fabricate facts, command output, tool results, or sources, and never claim ' +
  'to have run something you did not. If you lack the information or the ability to ' +
  'obtain it, say so plainly — reporting a blocker honestly is always better than ' +
  'inventing a result. Reply directly and naturally, in prose. Any background-memory ' +
  'section is recalled from earlier trails for your private reference — draw on it ' +
  'silently; never quote it, echo its heading, or mention that it exists.';

/** Tools gated through the approval hook (tool_call → ApprovalService double-write). */
const GATED_TOOLS = new Set(['execute_bash', 'schedule_task']);

/** The scope's current tip = predecessor for the next append. */
async function tip(pool: Pool, scopeId: string): Promise<string> {
  const { rows } = await pool.query<{ version_hash: string }>(
    'SELECT version_hash FROM execution_event_log WHERE scope_id = $1 ORDER BY id DESC LIMIT 1',
    [scopeId],
  );
  return rows[0]!.version_hash;
}

type LooseMessage = { role?: string; content?: string | Array<{ type?: string; text?: string }> };

/** Extract the assistant's reply text from a pi agent_end message list. */
function extractAssistantText(messages: unknown): string {
  const msgs = (messages ?? []) as LooseMessage[];
  const last = [...msgs].reverse().find((m) => m.role === 'assistant');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  return (last.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
}

/**
 * C3 (ADR-57 D-3): the graph is the terminal's working memory.
 * - before_agent_start: record the user turn to the graph (processAgentTurn), inject
 *   the background-memory block every turn, and inject the prior-conversation
 *   transcript ONLY on the first turn (cross-session/scope continuity — pi holds
 *   the live message list for subsequent in-session turns, so re-injecting would
 *   duplicate). This refines D-3 for a persistent TUI: the run-c3-loop proof used a
 *   fresh session per turn to PROVE graph-as-memory; the product keeps pi's
 *   in-session list (the per-turn projection that happens to live in the process)
 *   and still flushes every turn to the graph, the durable record.
 * - agent_end: flush the assistant turn to the graph.
 */
function makeC3Factory(pool: Pool, scopeId: string): ExtensionFactory {
  let injectedHistory = false;
  let pending: { turnId: string } | null = null;

  return (pi) => {
    pi.on('before_agent_start', async (event) => {
      const turnId = randomUUID();
      const outcome = await processAgentTurn(
        pool,
        scopeId,
        {
          entity_id: randomUUID(),
          event_type: 'memory_updated',
          predecessor_hash: await tip(pool, scopeId),
          payload: { kind: 'conversation.user', turn_id: turnId, text: event.prompt },
        },
        WMAX,
        null,
      );
      pending = { turnId };

      const mem =
        !outcome.suspended && 'context' in outcome && outcome.context
          ? conversationMemoryBlock(outcome.context)
          : '';

      let transcript = '';
      if (!injectedHistory) {
        const history = await loadConversationHistory(pool, scopeId, turnId);
        transcript = history.map((m) => `${m.role}: ${m.content}`).join('\n');
        injectedHistory = true;
      }

      const block = [transcript && `Prior conversation (from your memory):\n${transcript}`, mem]
        .filter(Boolean)
        .join('\n\n');
      return block ? { systemPrompt: event.systemPrompt + '\n\n' + block } : undefined;
    });

    pi.on('agent_end', async (event) => {
      const turnReply = extractAssistantText((event as { messages?: unknown }).messages);
      const turnId = pending?.turnId ?? randomUUID();
      pending = null;
      // Predecessor MUST be the current tip, not the user turn's hash: tools
      // (execute_bash) append their own events between before_agent_start and
      // agent_end, moving the tip. Using the stale user hash here causes an OCC
      // conflict and the assistant turn silently never lands.
      await occWrite(pool, {
        scopeId,
        entityId: randomUUID(),
        predecessorHash: await tip(pool, scopeId),
        eventType: 'memory_updated',
        payload: { kind: 'conversation.assistant', turn_id: turnId, text: turnReply },
      });
    });
  };
}

/**
 * Approval (ADR-57 D-4): intercept gated tools at tool_call. File a real
 * ApprovalService request, decide (ctx.ui.confirm in a TUI; CommandGate policy
 * headless), record the decision, and block on deny. The audit row is the SSOT;
 * the local confirm is the UX fast path.
 */
function makeApprovalFactory(pool: Pool, scopeId: string): ExtensionFactory {
  const approvals = new ApprovalService(pool);
  return (pi) => {
    pi.on('tool_call', async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
      if (!GATED_TOOLS.has(event.toolName)) return undefined;
      // execute_bash carries a command → safety gate (CommandGate). Other gated
      // tools (schedule_task) are autonomy-gated, not safety-gated: headless they
      // proceed (the local operator consented by scripting the run); in a TUI the
      // human confirms either way. The audit row is written regardless (SSOT).
      const isCommand = event.toolName === 'execute_bash';
      const subject = isCommand
        ? String((event.input as { command?: unknown }).command ?? '')
        : `${event.toolName} ${JSON.stringify(event.input)}`;
      const headlessOk = isCommand ? checkCommand(subject).allowed : true;
      const approvalId = await approvals.request(scopeId, 'mcp-agent', subject);
      const approved = ctx.hasUI ? await ctx.ui.confirm('Approve action?', subject) : headlessOk;
      await approvals.decide(approvalId, approved, 'once');
      if (!approved) return { block: true, reason: `denied by approval ${approvalId.slice(0, 8)}` };
      return undefined;
    });
  };
}

/**
 * The Core tool set bound in-process to Pi. Each tool takes only its task args;
 * the scope (graph identity) is supplied by the terminal closure, never by the
 * model (C3: the graph, not the model, owns the scope).
 */
function makeCoreTools(pool: Pool, scopeId: string, cwd: string): ToolDefinition[] {
  const executeBash = defineTool({
    name: 'execute_bash',
    label: 'Execute Bash',
    description: 'Run a bash command on the host and return its output. Use this to run the requested command.',
    parameters: Type.Object({ command: Type.String() }),
    async execute(_id, params) {
      const command = (params as { command: string }).command;
      // Run in the terminal's launch dir (a coding terminal acts on the user's
      // project), not tmpdir. The local backend records the scope's project from
      // this cwd (CONSOLE-REDESIGN §11.1).
      const result = await runExecuteBash(pool, {
        command,
        scopeId,
        predecessorHash: await tip(pool, scopeId),
        cwd,
      });
      return {
        content: [{ type: 'text' as const, text: result.text }],
        details: { command },
        isError: result.isError,
      };
    },
  });
  // schedule_task (ADR-57 D-6) — Hermes-parity autonomy tool, terminal-only.
  // Graph-native: appends a cron_job to the cron registry scope; the running
  // gateway-bot's CronService.tick() fires it (ADR-45). Approval-gated. Never
  // exposed to the channel conversation core (ADR-54 / Phase 14 redline).
  const scheduleTask = defineTool({
    name: 'schedule_task',
    label: 'Schedule Task',
    description:
      'Schedule a recurring future task. `schedule` is a 5-field cron expression ' +
      '(minute hour day-of-month month day-of-week). When it fires, the gateway runs ' +
      '`prompt` in a fresh scope and delivers the result to `deliver` (default: all ' +
      'configured channels). Requires approval.',
    parameters: Type.Object({
      schedule: Type.String(),
      prompt: Type.String(),
      deliver: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      const p = params as { schedule: string; prompt: string; deliver?: string };
      const name = `terminal:${Date.now().toString(36)}`;
      const deliver = p.deliver ?? 'all';
      await upsertCronJob(pool, { name, schedule: p.schedule, prompt: p.prompt, deliver, enabled: true });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ scheduled: name, schedule: p.schedule, deliver }) }],
        details: { name },
        isError: false,
      };
    },
  });

  return [executeBash, scheduleTask];
}

/** Pi agent dir for the embed — memex-owned, kept away from the user's ~/.pi. */
function memexAgentDir(): string {
  const dir = join(homedir(), '.memex', 'terminal-agent');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface MemexTerminalRuntime {
  runtime: AgentSessionRuntime;
  scopeId: string;
}

/**
 * Assemble the MemexTerminal runtime: Core brain + C3 + Core tools + approval +
 * hermetic isolation, wrapped in a Pi AgentSessionRuntime that InteractiveMode
 * (or the -m single-turn path) drives.
 */
export async function createMemexTerminalRuntime(opts: {
  pool: Pool;
  scopeId: string;
  cwd?: string;
}): Promise<MemexTerminalRuntime> {
  const { pool, scopeId } = opts;
  const cwd = opts.cwd ?? process.cwd();
  const agentDir = memexAgentDir();
  const { authStorage, modelRegistry, model } = buildCoreModelRegistry();

  const factories: ExtensionFactory[] = [makeC3Factory(pool, scopeId), makeApprovalFactory(pool, scopeId)];
  const tools = makeCoreTools(pool, scopeId, cwd);

  const runtime = await createAgentSessionRuntime(
    async ({ cwd: factoryCwd, sessionManager, sessionStartEvent }) => {
      const services = await createAgentSessionServices({
        cwd: factoryCwd,
        authStorage,
        modelRegistry,
        resourceLoaderOptions: {
          ...EMBED_RESOURCE_ISOLATION,
          systemPrompt: MEMEX_TERMINAL_SYSTEM_ROLE,
          extensionFactories: factories,
        },
      });
      const result = await createAgentSessionFromServices({
        services,
        sessionManager,
        model,
        noTools: 'builtin',
        customTools: tools,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
      });
      return { ...result, services, diagnostics: services.diagnostics };
    },
    { cwd, agentDir, sessionManager: SessionManager.inMemory() },
  );

  return { runtime, scopeId };
}
