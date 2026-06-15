/**
 * Build-out line #2 (real ledger) — agent_end flushes the turn to the REAL
 * graph via occWrite, into a REAL scope created with nestScope. Proves C3's
 * write-back half against Postgres: the turn becomes a durable trail event.
 *
 * Run: `npx tsx src/run-ledger.mts` from packages/terminal-pi (needs DATABASE_URL
 * + NVIDIA_API_KEY in env/.env, and the postgres stack up).
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { occWrite } from '@graph/shared';
import { nestScope } from '@graph/control-plane/nesting';
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

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// Real scope (nestScope runs the 3-phase partition DDL); planHash = the tip.
const { scopeId, planHash } = await nestScope(pool, `session:terminal-pi:ledger:${Date.now()}`);
console.log('[ledger] scope', scopeId.slice(0, 8), 'tip', planHash.slice(0, 12));

const turnId = randomUUID();
let assistantText = '';
let writtenHash = '';

// C3 write-back: agent_end -> real occWrite of the assistant turn into the scope.
const flushExt: ExtensionFactory = (pi) => {
  pi.on('agent_end', async (event: { messages?: { role?: string; content?: { type: string; text?: string }[] }[] }) => {
    const last = [...(event.messages ?? [])].reverse().find((m) => m.role === 'assistant');
    assistantText = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const res = await occWrite(pool, {
      scopeId,
      entityId: randomUUID(),
      predecessorHash: planHash,
      eventType: 'memory_updated',
      payload: { kind: 'conversation.assistant', turn_id: turnId, text: assistantText },
    });
    writtenHash = res.version_hash;
    console.log('[ledger] occWrite ->', res.occ_result, res.version_hash.slice(0, 12));
  });
};

const { session, core } = await buildSessionWithCoreBrain({ extensionFactories: [flushExt] });
console.log('[ledger] brain', core.name, core.model);
await session.prompt('Reply with exactly: LEDGER-OK');
// agent_end runs async; let an unawaited flush settle before we query.
for (let i = 0; i < 20 && writtenHash === ''; i++) await new Promise((r) => setTimeout(r, 100));
console.log('[ledger] assistant', assistantText.trim());

// Verify the turn is durably in the real ledger.
const q = await pool.query<{ event_type: string; version_hash: string; kind: string; text: string }>(
  `SELECT event_type, version_hash, payload::jsonb->>'kind' AS kind, payload::jsonb->>'text' AS text
     FROM execution_event_log WHERE scope_id = $1 AND payload::jsonb->>'turn_id' = $2`,
  [scopeId, turnId],
);
console.log('[ledger] rows found:', q.rows.length, JSON.stringify(q.rows[0] ?? null));
const ok = q.rows.length === 1 && q.rows[0]!.version_hash === writtenHash && q.rows[0]!.kind === 'conversation.assistant';
console.log(ok ? '[ledger] PASS — turn persisted to the real graph' : '[ledger] FAIL');
await pool.end();
process.exit(ok ? 0 : 1);
