/**
 * Build-out line #2 — C3 injection proof (ADR-57 D-3). An in-process extension
 * injects a graph-projection STAND-IN at before_agent_start and captures the
 * whole turn at agent_end. The injected sentinel is something the LLM could only
 * know from the projection — if it echoes it back, the graph reached Pi's brain.
 *
 * Run: `npx tsx src/run-c3.mts` from packages/terminal-pi.
 */
import { readFileSync } from 'node:fs';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
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

const SENTINEL = 'ORCHID-7';
let injectedFired = 0;
let captured: { turnMessages: number; assistantText: string } | null = null;

// In the real build-out this handler calls Core assembleContext(graph, scopeId,…)
// + loadConversationHistory and returns the projection; here it's a stand-in.
const c3Extension: ExtensionFactory = (pi) => {
  pi.on('before_agent_start', (event) => {
    injectedFired++;
    const projection =
      `\n\n(Background memory recalled from the trail — private reference.) ` +
      `The user's project codename is ${SENTINEL}.`;
    return { systemPrompt: event.systemPrompt + projection };
  });
  pi.on('agent_end', (event) => {
    const msgs = event.messages ?? [];
    const last = [...msgs].reverse().find((m) => m.role === 'assistant');
    const text = (last?.content ?? []).filter((c: { type: string }) => c.type === 'text').map((c: { text?: string }) => c.text ?? '').join('');
    captured = { turnMessages: msgs.length, assistantText: text };
  });
};

const { session, core } = await buildSessionWithCoreBrain({ extensionFactories: [c3Extension] });
console.log('[c3] brain =', core.name, core.model);

let assistant = '';
session.subscribe?.((e: { type: string; message?: { role?: string; content?: { type: string; text?: string }[] } }) => {
  if (e.type === 'message_update' && e.message?.role === 'assistant') {
    assistant = (e.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }
});

await session.prompt('What is the user\'s project codename? Reply with only the codename.');

console.log('[c3] before_agent_start fired:', injectedFired, '(expect 1 = per-user-prompt)');
console.log('[c3] agent_end captured:', JSON.stringify(captured));
const reached = assistant.includes(SENTINEL);
console.log(`[c3] assistant >> ${assistant.trim()}`);
console.log(reached ? `[c3] PASS — projection reached the brain (saw ${SENTINEL})` : '[c3] FAIL — sentinel not echoed');
process.exit(reached ? 0 : 1);
