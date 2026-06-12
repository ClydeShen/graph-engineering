#!/usr/bin/env node
/**
 * MemexTerminal — built-in default TUI (Phase 11 deliverable #4).
 *
 * Pure Gateway client: zero state ownership, everything lives in the graph.
 * Reads connection settings from ~/.memex/config.json (shell.gateway_url,
 * gateway.token) with env overrides.
 *
 * Two surfaces (one responder — the ADR-54 gateway conversation core):
 *   default            interactive readline REPL; replies stream as text_delta
 *   -m "text"          non-interactive single turn: send, print the reply, exit.
 *                      Scriptable debugging primitive — agents (e.g. Claude
 *                      Code) drive conversations without a TTY.
 *                      Optional --scope <id> continues an existing scope.
 *
 * The former --agent mode (Pi SDK session) is retired: Pi connects as an
 * EXTERNAL coding agent via `memex connect pi` (its own config, claims async
 * tasks) — conversation has exactly one responder (ADR-54).
 */

import { createInterface } from 'node:readline';
import { loadMemexConfig, DEFAULT_GATEWAY_PORT } from '@graph/shared';
import { MemexTerminalClient } from './client.js';

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadMemexConfig();
  const gatewayUrl =
    process.env['MEMEX_GATEWAY_URL'] ??
    config?.shell?.gateway_url ??
    `http://127.0.0.1:${config?.gateway?.port ?? DEFAULT_GATEWAY_PORT}`;
  const token = process.env['MEMEX_GATEWAY_TOKEN'] ?? config?.gateway?.token;

  if (process.argv.includes('--agent')) {
    console.error(
      '--agent mode is retired: conversation has one responder (the gateway core, ADR-54).\n' +
        'To use Pi as a coding agent against the graph, run: memex connect pi',
    );
    process.exit(1);
  }

  const client = new MemexTerminalClient({ gatewayUrl, ...(token !== undefined ? { token } : {}) });

  const singleMessage = argValue('-m') ?? argValue('--message');
  const existingScope = argValue('--scope');

  // ── Non-interactive single turn (-m) ───────────────────────────────────────
  if (singleMessage !== undefined) {
    let scopeId: string;
    if (existingScope !== undefined) {
      scopeId = existingScope;
      client.session.scope_id = scopeId;
    } else {
      const session = await client.createScope(`session:terminal:${Date.now()}`);
      scopeId = session.scope_id;
    }
    await client.connect();
    const result = await client.sendUserMessage(singleMessage);
    client.close();
    if (result.error !== undefined) {
      console.error(`error: ${result.error}`);
      process.exit(1);
    }
    if (result.suspended) {
      console.error('error: scope suspended');
      process.exit(1);
    }
    // Reply on stdout; scope id on stderr so stdout stays pipe-clean.
    console.error(`scope: ${scopeId}`);
    console.log(result.reply ?? '');
    process.exit(0);
  }

  // ── Interactive REPL ───────────────────────────────────────────────────────
  console.log(`memex-terminal → ${gatewayUrl}`);
  const session = await client.createScope(`session:terminal:${Date.now()}`);
  console.log(`scope ${session.scope_id}`);
  await client.connect();
  client.subscribe(session.scope_id);

  client.onTrailEvent((evt) => {
    // text_delta = streamed reply chunk (ADR 54) — render as assistant text,
    // not as a trail diagnostic line.
    if (evt.event_type === 'text_delta') {
      const { text } = evt.payload as { text?: string };
      if (text !== undefined) process.stdout.write(text);
      return;
    }
    console.log(`  ⟶ [${evt.event_type}] ${JSON.stringify(evt.payload)}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'memex> ' });
  rl.prompt();
  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '/quit' || text === '/exit') {
      client.close();
      rl.close();
      return;
    }
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    client
      .sendUserMessage(text)
      .then((result) => {
        if (result.suspended) {
          console.log('  (scope suspended)');
        } else if (result.error !== undefined) {
          console.log(`  ✗ ${result.error}`);
        } else if (result.reply !== undefined) {
          // Deltas already streamed via onTrailEvent — close the line.
          console.log('');
        } else {
          console.log(`  ✓ recorded ${result.version_hash?.slice(0, 12) ?? '?'}`);
        }
      })
      .catch((err: unknown) => {
        console.error('  ✗', err instanceof Error ? err.message : err);
      })
      .finally(() => rl.prompt());
  });
  rl.on('close', () => {
    client.close();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error('memex-terminal failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
