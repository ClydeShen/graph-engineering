/**
 * In-repo live check (build-out line #1): drive one real turn through Pi using
 * Core's onboarded provider via the bridge. Run: `npx tsx src/run-nvidia.mts`
 * from packages/terminal-pi (needs NVIDIA_API_KEY in env / .env).
 */
import { readFileSync } from 'node:fs';
import { buildSessionWithCoreBrain } from './provider-bridge.js';

// Load .env into process.env so loadMemexConfig can ${NVIDIA_API_KEY}-interpolate.
for (const root of ['.env', '../../.env', 'D:/Repo/graph-enginerring/.env']) {
  try {
    for (const line of readFileSync(root, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  } catch {
    /* try next */
  }
}

const { session, core } = await buildSessionWithCoreBrain();
console.log('[run] brain =', core.name, core.model, '@', core.baseUrl);

let assistant = '';
session.subscribe?.((e: { type: string; message?: { role?: string; content?: { type: string; text?: string }[] } }) => {
  if (e.type === 'message_update' && e.message?.role === 'assistant') {
    assistant = (e.message.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
  }
});

await session.prompt('Reply with exactly: MEMEX-PI-OK');
console.log('[run] ASSISTANT >>', assistant || '(empty)');
process.exit(0);
