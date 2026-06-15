#!/usr/bin/env node
/**
 * MemexTerminal (Pi-embed) entry — the agentic terminal launched by `memex chat`
 * (ADR-57). Two surfaces over one runtime (createMemexTerminalRuntime):
 *
 *   default        interactive Pi TUI (InteractiveMode) — full chat + streaming +
 *                  approval dialogs, DRY: pi brings the loop/approval/TUI.
 *   -m "text"      non-interactive single turn: send, print the reply, exit.
 *                  Scriptable primitive (agents drive it without a TTY).
 *                  Optional --scope <id> continues an existing graph scope.
 *
 * The brain is Core's onboarded provider (config-share); the graph is the working
 * memory (C3); tools/approval/isolation are wired in terminal.ts. Unlike the old
 * thin MemexTerminalClient (WS to the gateway conversation core, one responder),
 * this IS the agentic responder — per-surface law (ADR-57): channel = conversation
 * core (no tools), terminal = Pi agentic (full tools).
 */
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { nestScope } from '@graph/control-plane/nesting';
import { InteractiveMode, initTheme } from '@earendil-works/pi-coding-agent';
import { createMemexTerminalRuntime } from './terminal.js';

/** Defensive .env load for standalone runs; in production the CLI sets env. */
function loadDotEnv(): void {
  for (const root of ['.env', '../../.env']) {
    try {
      for (const line of readFileSync(root, 'utf8').split(/\r?\n/)) {
        const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
        if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      return;
    } catch {
      /* next */
    }
  }
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/**
 * Wait for the assistant reply this scope records (written by C3 agent_end).
 * prompt() can resolve before the agent_end handler's occWrite lands, so poll the
 * graph briefly rather than racing it. Returns the reply, or '' on timeout.
 */
async function waitForAssistantText(pool: pg.Pool, scopeId: string, sinceId: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const { rows } = await pool.query<{ id: number; text: string }>(
      `SELECT id, payload::jsonb->>'text' AS text FROM execution_event_log
         WHERE scope_id = $1 AND payload::jsonb->>'kind' = 'conversation.assistant' AND id > $2
         ORDER BY id DESC LIMIT 1`,
      [scopeId, sinceId],
    );
    if (rows[0]) return rows[0].text ?? '';
    await new Promise((r) => setTimeout(r, 100));
  }
  return '';
}

/** Highest event id in the scope right now — the watermark before this turn's reply. */
async function scopeTipId(pool: pg.Pool, scopeId: string): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    'SELECT COALESCE(MAX(id), 0) AS id FROM execution_event_log WHERE scope_id = $1',
    [scopeId],
  );
  return rows[0]?.id ?? 0;
}

async function main(): Promise<void> {
  loadDotEnv();
  const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });

  const singleMessage = argValue('-m') ?? argValue('--message');
  const existingScope = argValue('--scope');
  const scopeId = existingScope ?? (await nestScope(pool, `session:terminal:${Date.now()}`)).scopeId;

  const { runtime } = await createMemexTerminalRuntime({ pool, scopeId });

  // ── Non-interactive single turn (-m) ───────────────────────────────────────
  if (singleMessage !== undefined) {
    const sinceId = await scopeTipId(pool, scopeId);
    await runtime.session.prompt(singleMessage);
    const reply = await waitForAssistantText(pool, scopeId, sinceId);
    await runtime.dispose();
    await pool.end();
    // Reply on stdout; scope id on stderr so stdout stays pipe-clean.
    console.error(`scope: ${scopeId}`);
    console.log(reply);
    process.exit(0);
  }

  // ── Interactive Pi TUI ─────────────────────────────────────────────────────
  initTheme(undefined, true);
  const mode = new InteractiveMode(runtime, {});
  await mode.run();
  await runtime.dispose();
  await pool.end();
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error('memex-terminal failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
