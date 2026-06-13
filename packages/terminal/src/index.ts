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
  // Observatory palette (mirrors scripts/dev.mjs): brass signal, dim chrome.
  // Colour is suppressed when stdout is not a TTY (piped/agent runs stay clean).
  const tty = process.stdout.isTTY === true;
  const C = tty
    ? { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', brass: '\x1b[38;5;179m', moss: '\x1b[38;5;108m', rust: '\x1b[38;5;167m' }
    : { reset: '', dim: '', bold: '', brass: '', moss: '', rust: '' };

  const session = await client.createScope(`session:terminal:${Date.now()}`);
  await client.connect();
  client.subscribe(session.scope_id);

  console.log(`
  ${C.brass}${C.bold}✦ MemexTerminal${C.reset}  ${C.dim}— talk to the memex; every turn is written to the trail${C.reset}
  ${C.dim}gateway ${C.reset}${gatewayUrl}   ${C.dim}scope ${C.reset}${session.scope_id.slice(0, 8)}
  ${C.dim}/quit to exit${C.reset}
`);

  const PROMPT = `${C.brass}memex ❯${C.reset} `;

  client.onTrailEvent((evt) => {
    // text_delta = streamed reply chunk (ADR 54) — render as assistant text,
    // not as a trail diagnostic line.
    if (evt.event_type === 'text_delta') {
      const { text } = evt.payload as { text?: string };
      if (text !== undefined) process.stdout.write(text);
      return;
    }
    // Every conversation turn writes memory_updated ×2 (user + assistant) —
    // echoing those back is pure noise in a chat surface (UX-audit U15).
    // Other trail events (task_spawned, conflicts, …) stay visible.
    if (evt.event_type === 'memory_updated') return;
    console.log(`  ${C.dim}⟶ [${evt.event_type}] ${JSON.stringify(evt.payload)}${C.reset}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: PROMPT });
  rl.prompt();
  // Turns run strictly one at a time. With piped stdin all lines (and EOF)
  // arrive at once — without this chain, /quit or stream close would drop
  // in-flight messages (UX-audit U8).
  let chain: Promise<void> = Promise.resolve();
  const runTurn = async (text: string): Promise<void> => {
    // Assistant marker prints before the await so streamed deltas append to it.
    process.stdout.write(`${C.moss}◆${C.reset} `);
    try {
      const result = await client.sendUserMessage(text);
      if (result.suspended) {
        console.log(`${C.rust}(scope suspended)${C.reset}`);
      } else if (result.error !== undefined) {
        console.log(`${C.rust}✗ ${result.error}${C.reset}`);
      } else if (result.reply !== undefined) {
        // Deltas already streamed via onTrailEvent — close the line.
        console.log('');
      } else {
        console.log(`${C.dim}✓ recorded ${result.version_hash?.slice(0, 12) ?? '?'}${C.reset}`);
      }
    } catch (err) {
      console.error(`${C.rust}✗`, err instanceof Error ? err.message : err, C.reset);
    }
    console.log('');
    rl.prompt();
  };
  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '/quit' || text === '/exit') {
      chain = chain.then(() => {
        client.close();
        rl.close();
      });
      return;
    }
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    chain = chain.then(() => runTurn(text));
  });
  rl.on('close', () => {
    // Let any in-flight turn finish before tearing the process down.
    void chain.then(() => {
      client.close();
      process.exit(0);
    });
  });
}

main().catch((err: unknown) => {
  console.error('memex-terminal failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
