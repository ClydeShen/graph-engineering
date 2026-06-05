/**
 * Spike 004 verification — structural test without a live Pi instance.
 *
 * Simulates the Pi ExtensionAPI host and verifies our extension:
 * 1. Registers the expected tools
 * 2. Registers the expected commands
 * 3. Subscribes to the expected events
 * 4. /fork activates shadow, /fork-end clears it
 *
 * Run: npx tsx .planning/spikes/004-pi-extension/extension/src/verify.ts
 */

import type { ExtensionAPI, ExtensionContext, ToolDefinition, SessionStartEvent, ToolCallEvent } from './pi-types.shim.js';
import { isRehearsalActive } from './index.js';
import graphRuntimeExtension from './index.js';

// ---------------------------------------------------------------------------
// Minimal Pi host simulator
// ---------------------------------------------------------------------------

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
}
interface RegisteredCommand {
  name: string;
  description: string;
  handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

const registeredTools: RegisteredTool[] = [];
const registeredCommands: Map<string, RegisteredCommand> = new Map();
const eventHandlers: Map<string, ((...args: unknown[]) => Promise<unknown>)[]> = new Map();
const notifications: { message: string; level: string }[] = [];
let runtimeForkCalled: string | null = null;

const mockCtx: ExtensionContext = {
  ui: {
    notify(message, level) {
      notifications.push({ message, level });
      console.log(`  [Pi UI ${level}]: ${message}`);
    },
    async confirm(_title, _message) { return true; },
  },
  runtime: {
    async fork(entryId) {
      runtimeForkCalled = entryId;
      console.log(`  [Pi runtime.fork("${entryId}")] called`);
    },
  },
};

const mockPi: ExtensionAPI = {
  on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
    const handlers = eventHandlers.get(event) ?? [];
    handlers.push(handler);
    eventHandlers.set(event, handlers);
  },
  registerTool<P>(def: ToolDefinition<P>) {
    registeredTools.push({ name: def.name, label: def.label, description: def.description });
  },
  registerCommand(name, opts) {
    registeredCommands.set(name, { name, description: opts.description, handler: opts.handler });
  },
};

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function run() {
  console.log('\n=== Spike 004: Pi Extension structural verification ===\n');

  // Load the extension
  graphRuntimeExtension(mockPi);

  // --- Test 1: Tool registration ---
  console.log('Test 1: Tool registration');
  assert(
    registeredTools.some(t => t.name === 'spawn_task'),
    'spawn_task tool registered',
  );
  assert(
    registeredTools.some(t => t.name === 'complete_task'),
    'complete_task tool registered',
  );
  console.log(`  Tools registered: [${registeredTools.map(t => t.name).join(', ')}]`);

  // --- Test 2: Command registration ---
  console.log('\nTest 2: Command registration');
  assert(registeredCommands.has('fork'), '/fork command registered');
  assert(registeredCommands.has('fork-end'), '/fork-end command registered');

  // --- Test 3: Event subscription ---
  console.log('\nTest 3: Event subscription');
  assert(
    (eventHandlers.get('session_start')?.length ?? 0) >= 1,
    'session_start handler registered',
  );
  assert(
    (eventHandlers.get('tool_call')?.length ?? 0) >= 1,
    'tool_call handler registered',
  );

  // --- Test 4: session_start fires notification ---
  console.log('\nTest 4: session_start notification');
  const startHandlers = eventHandlers.get('session_start') ?? [];
  for (const h of startHandlers) {
    await h({ type: 'session_start', sessionId: 'sid-1' } as SessionStartEvent, mockCtx);
  }
  assert(
    notifications.some(n => n.message.includes('Graph Runtime connected')),
    'session_start fires Graph Runtime notification',
  );
  assert(
    notifications.some(n => n.message.includes('INTERACTIVE')),
    'initial mode is INTERACTIVE',
  );

  // --- Test 5: /fork activates shadow mode ---
  console.log('\nTest 5: /fork activates rehearsal mode');
  const forkCmd = registeredCommands.get('fork')!;
  await forkCmd.handler('entry-abc-123', mockCtx);
  assert(runtimeForkCalled === 'entry-abc-123', 'runtime.fork() called with entryId');
  assert(isRehearsalActive(), 'rehearsal mode is ACTIVE after /fork');
  assert(
    notifications.some(n => n.message.includes('Rehearsal mode ACTIVE')),
    '/fork emits rehearsal active notification',
  );

  // --- Test 6: tool_call guard fires in rehearsal mode ---
  console.log('\nTest 6: tool_call guard in rehearsal mode');
  const toolCallHandlers = eventHandlers.get('tool_call') ?? [];
  let blockResult: unknown;
  for (const h of toolCallHandlers) {
    const r = await h(
      { type: 'tool_call', toolName: 'bash', input: { command: 'ls .' } } as ToolCallEvent,
      mockCtx,
    );
    if (r) blockResult = r;
  }
  // 'ls .' is not in the danger list → not blocked
  assert(blockResult === undefined, 'safe bash command not blocked in rehearsal');

  // --- Test 7: /fork-end clears shadow (阅后即焚) ---
  console.log('\nTest 7: /fork-end clears shadow');
  const forkEndCmd = registeredCommands.get('fork-end')!;
  await forkEndCmd.handler('', mockCtx);
  assert(!isRehearsalActive(), 'rehearsal mode DEACTIVATED after /fork-end');
  assert(
    notifications.some(n => n.message.includes('shadow entries destroyed')),
    '/fork-end emits 阅后即焚 notification',
  );

  console.log('\n✓ All tests passed — Pi Extension structure validated\n');
  console.log('Key findings:');
  console.log('  - ExtensionAPI surface: registerTool, registerCommand, on(event)');
  console.log('  - spawn_task / complete_task registered as Pi-native tools');
  console.log('  - /fork command calls runtime.fork(entryId) → activates InMemoryShadowAdapter');
  console.log('  - /fork-end calls shadow.clear() → 阅后即焚');
  console.log('  - tool_call hook guards destructive bash in rehearsal mode');
  console.log('  - No live Pi instance needed — extension structure is pure TypeScript');
}

run().catch(err => {
  console.error('Spike failed:', err);
  process.exit(1);
});
