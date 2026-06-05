/**
 * Spike 004 verification (corrected) — structural test without live Pi.
 *
 * Verifies corrected API understanding:
 * - ctx in event handlers: ExtensionContext (no fork, no runtime)
 * - ctx in command handlers: ExtensionCommandContext (ctx.fork() directly)
 * - session_before_fork activates shadow without a custom /fork command
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
  ToolDefinition,
  SessionStartEvent,
  SessionBeforeForkEvent,
  ToolCallEvent,
} from './pi-types.shim.js';
import { isRehearsalActive } from './index.js';
import graphRuntimeExtension from './index.js';

// ---------------------------------------------------------------------------
// Pi host simulator
// ---------------------------------------------------------------------------

interface RegisteredTool { name: string; label: string }
interface RegisteredCommand {
  name: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

const registeredTools: RegisteredTool[] = [];
const registeredCommands = new Map<string, RegisteredCommand>();
const eventHandlers = new Map<string, ((...args: unknown[]) => Promise<unknown>)[]>();
const notifications: { message: string; level: string }[] = [];
let forkCalledWith: string | null = null;

const mockEventCtx: ExtensionContext = {
  ui: {
    notify(message, level) {
      notifications.push({ message, level });
      console.log(`  [Pi ctx.ui ${level}]: ${message}`);
    },
    async confirm() { return true; },
  },
  mode: 'tui',
  hasUI: true,
  cwd: process.cwd(),
  sessionManager: null,
  signal: new AbortController().signal,
};

// ExtensionCommandContext — extends event ctx with fork()
const mockCmdCtx: ExtensionCommandContext = {
  ...mockEventCtx,
  async fork(entryId) {
    forkCalledWith = entryId;
    console.log(`  [Pi ctx.fork("${entryId}")] called`);
  },
  async newSession() {},
  async switchSession() {},
  async navigateTree() {},
  async waitForIdle() {},
  async reload() {},
};

const mockPi: ExtensionAPI = {
  on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
    const list = eventHandlers.get(event) ?? [];
    list.push(handler);
    eventHandlers.set(event, list);
  },
  registerTool<P>(def: ToolDefinition<P>) {
    registeredTools.push({ name: def.name, label: def.label });
  },
  registerCommand(name, opts) {
    registeredCommands.set(name, { name, handler: opts.handler });
  },
  exec: async () => ({}),
  sendMessage: async () => {},
  getActiveTools: () => [],
  setActiveTools: () => {},
};

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exit(1); }
  console.log(`  PASS: ${msg}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  console.log('\n=== Spike 004 (corrected): Pi Extension verification ===\n');
  console.log('API fix: ctx.fork() on ExtensionCommandContext, NOT ctx.runtime.fork()\n');

  graphRuntimeExtension(mockPi);

  // Test 1: Tool registration
  console.log('Test 1: Tool registration');
  assert(registeredTools.some(t => t.name === 'spawn_task'), 'spawn_task registered');
  assert(registeredTools.some(t => t.name === 'complete_task'), 'complete_task registered');

  // Test 2: Command registration
  console.log('\nTest 2: Command registration');
  assert(registeredCommands.has('fork-ext'), '/fork-ext registered');
  assert(registeredCommands.has('fork-end'), '/fork-end registered');

  // Test 3: session_before_fork event activates shadow (Pi native /fork hook)
  console.log('\nTest 3: session_before_fork → shadow activation (Pi native /fork hook)');
  const forkHandlers = eventHandlers.get('session_before_fork') ?? [];
  assert(forkHandlers.length >= 1, 'session_before_fork handler registered');

  for (const h of forkHandlers) {
    await h({ type: 'session_before_fork', entryId: 'entry-native-fork' } as SessionBeforeForkEvent, mockEventCtx);
  }
  assert(isRehearsalActive(), 'shadow ACTIVE after session_before_fork');
  assert(
    notifications.some(n => n.message.includes('Rehearsal mode ACTIVE')),
    'shadow activation notification sent',
  );

  // Reset shadow for next test
  const forkEndCmd = registeredCommands.get('fork-end')!;
  await forkEndCmd.handler('', mockCmdCtx);
  assert(!isRehearsalActive(), 'shadow cleared by /fork-end');

  // Test 4: /fork-ext uses ctx.fork() (not ctx.runtime.fork())
  console.log('\nTest 4: /fork-ext command uses ctx.fork() on ExtensionCommandContext');
  const forkExtCmd = registeredCommands.get('fork-ext')!;
  await forkExtCmd.handler('entry-explicit-fork', mockCmdCtx);
  assert(forkCalledWith === 'entry-explicit-fork', 'ctx.fork() called with entryId');
  assert(isRehearsalActive(), 'shadow ACTIVE after /fork-ext');

  // Test 5: session_start shows REHEARSAL mode when shadow is active
  console.log('\nTest 5: session_start notification reflects rehearsal state');
  const startHandlers = eventHandlers.get('session_start') ?? [];
  for (const h of startHandlers) {
    await h({ type: 'session_start', sessionId: 'sid-rehearsal' } as SessionStartEvent, mockEventCtx);
  }
  assert(
    notifications.some(n => n.message.includes('REHEARSAL')),
    'session_start shows REHEARSAL when shadow active',
  );

  // Test 6: tool_call guard in rehearsal mode
  console.log('\nTest 6: tool_call guard (safe cmd not blocked)');
  const toolHandlers = eventHandlers.get('tool_call') ?? [];
  let blockResult: unknown;
  for (const h of toolHandlers) {
    const r = await h(
      { type: 'tool_call', toolName: 'bash', input: { command: 'ls .' } } as ToolCallEvent,
      mockEventCtx,
    );
    if (r) blockResult = r;
  }
  assert(blockResult === undefined, 'safe ls . not blocked in rehearsal');

  // Test 7: /fork-end with ExtensionCommandContext
  console.log('\nTest 7: /fork-end clears shadow (阅后即焚)');
  await forkEndCmd.handler('', mockCmdCtx);
  assert(!isRehearsalActive(), 'shadow DEACTIVATED after /fork-end');

  console.log('\n✓ All tests passed — corrected Pi Extension API validated\n');
  console.log('API corrections confirmed:');
  console.log('  - session_before_fork event: hook Pi native /fork (no custom command needed)');
  console.log('  - ExtensionCommandContext.fork(entryId): direct method, NOT ctx.runtime.fork()');
  console.log('  - ExtensionContext (event handlers): NO fork, NO runtime property');
  console.log('  - /fork-ext command still valid as explicit override path');
}

run().catch(err => { console.error('Spike failed:', err); process.exit(1); });
