#!/usr/bin/env node
/**
 * MemexTerminal — built-in default TUI (Phase 11 deliverable #4).
 *
 * Pure Gateway client: zero state ownership, everything lives in the graph.
 * Reads connection settings from ~/.memex/config.json (shell.gateway_url,
 * gateway.token) with env overrides.
 *
 * v1 surface: readline REPL over the WS protocol — user lines become
 * task_spawned events in the session scope; turn results and live trail
 * events render inline. The Pi-SDK interactive agent mode (createAgentSession
 * driving a local coding agent against this graph) is the documented next
 * increment — it needs a live gateway + provider keys to verify.
 */

import { createInterface } from 'node:readline';
import { loadMemexConfig } from '@graph/shared';
import { MemexTerminalClient } from './client.js';

async function main(): Promise<void> {
  const config = loadMemexConfig();
  const gatewayUrl =
    process.env['MEMEX_GATEWAY_URL'] ??
    config?.shell?.gateway_url ??
    `http://127.0.0.1:${config?.gateway?.port ?? 3000}`;
  const token = process.env['MEMEX_GATEWAY_TOKEN'] ?? config?.gateway?.token;

  const client = new MemexTerminalClient({ gatewayUrl, ...(token !== undefined ? { token } : {}) });

  console.log(`memex-terminal → ${gatewayUrl}`);
  const session = await client.createScope(`session:terminal:${Date.now()}`);
  console.log(`scope ${session.scope_id}`);
  await client.connect();
  client.subscribe(session.scope_id);
  client.onTrailEvent((evt) => {
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
        if (result.deduplicated) console.log('  (duplicate within 5min window — not re-recorded)');
        else if (result.suspended) console.log('  (scope suspended)');
        else console.log(`  ✓ recorded ${result.version_hash?.slice(0, 12)} (${result.occ_result})`);
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
