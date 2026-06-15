/**
 * Build-out line #2 (read-back) — close the C3 loop. before_agent_start injects
 * the REAL graph projection (processAgentTurn -> assembleContext + reflection)
 * AND the REAL prior conversation (loadConversationHistory); agent_end flushes
 * via occWrite. Each turn runs in a FRESH pi session (zero retained memory), so
 * turn 2 can only know turn 1 via the graph re-projection — proving Graph =
 * Pi's working memory (ADR-57 D-3).
 *
 * Run: `npx tsx src/run-c3-loop.mts` from packages/terminal-pi.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { occWrite } from '@graph/shared';
import { nestScope } from '@graph/control-plane/nesting';
import { processAgentTurn } from '@graph/gateway/process-agent-turn';
import { loadConversationHistory, conversationMemoryBlock } from '@graph/gateway/conversation';
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

const WMAX = 4000;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function tip(scopeId: string): Promise<string> {
  const { rows } = await pool.query<{ version_hash: string }>(
    'SELECT version_hash FROM execution_event_log WHERE scope_id = $1 ORDER BY id DESC LIMIT 1',
    [scopeId],
  );
  return rows[0]!.version_hash;
}

/** One conversation turn in a FRESH pi session — context comes only from the graph. */
async function chatTurn(scopeId: string, userText: string): Promise<string> {
  const turnId = randomUUID();
  let userHash = '';
  let injectedHistory = 0;
  let turnReply = '';

  const c3: ExtensionFactory = (pi) => {
    pi.on('before_agent_start', async (event: { systemPrompt: string }) => {
      // Write the user turn + get the real context projection (assembleContext).
      const outcome = await processAgentTurn(
        pool,
        scopeId,
        {
          entity_id: randomUUID(),
          event_type: 'memory_updated',
          predecessor_hash: await tip(scopeId),
          payload: { kind: 'conversation.user', turn_id: turnId, text: userText },
        },
        WMAX,
        null,
      );
      if (!outcome.suspended && 'version_hash' in outcome) userHash = outcome.version_hash;

      // Re-project prior turns from the graph (NOT pi's retained state).
      const history = await loadConversationHistory(pool, scopeId, turnId);
      injectedHistory = history.length;
      const transcript = history.map((m) => `${m.role}: ${m.content}`).join('\n');
      const mem = !outcome.suspended && 'context' in outcome && outcome.context ? conversationMemoryBlock(outcome.context) : '';
      const block = [transcript && `Prior conversation (from your memory):\n${transcript}`, mem]
        .filter(Boolean)
        .join('\n\n');
      return block ? { systemPrompt: event.systemPrompt + '\n\n' + block } : undefined;
    });

    pi.on('agent_end', async (event: { messages?: { role?: string; content?: { type: string; text?: string }[] }[] }) => {
      const last = [...(event.messages ?? [])].reverse().find((m) => m.role === 'assistant');
      turnReply = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
      console.log(`[loop]   agent_end: ${event.messages?.length ?? 0} msg(s), assistant text len=${turnReply.length}`);
      await occWrite(pool, {
        scopeId,
        entityId: randomUUID(),
        predecessorHash: userHash || (await tip(scopeId)),
        eventType: 'memory_updated',
        payload: { kind: 'conversation.assistant', turn_id: turnId, text: turnReply },
      });
    });
  };

  const { session } = await buildSessionWithCoreBrain({ extensionFactories: [c3] });
  await session.prompt(userText);
  for (let i = 0; i < 30 && turnReply === ''; i++) await new Promise((r) => setTimeout(r, 100));
  console.log(`[loop] turn injected ${injectedHistory} prior msg(s); reply: ${turnReply.trim()}`);
  return turnReply;
}

const { scopeId } = await nestScope(pool, `session:terminal-pi:c3loop:${Date.now()}`);
console.log('[loop] scope', scopeId.slice(0, 8));

await chatTurn(scopeId, 'My favorite color is teal. Please remember it.');
const r2 = await chatTurn(scopeId, 'What is my favorite color? Reply with only the color word.');

const ok = /teal/i.test(r2);
console.log(ok
  ? '[loop] PASS — a fresh pi session recalled "teal" from the graph (Graph = working memory)'
  : '[loop] FAIL — fresh session did not recall from the graph');
await pool.end();
process.exit(ok ? 0 : 1);
