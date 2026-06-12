/**
 * MemexTerminal agent mode (Phase 18 #6 — the Phase 11 documented next
 * increment): a Pi SDK agent session drives the conversation; the graph stays
 * the permanent record.
 *
 * Architecture: Shell owns NO state. The Pi session is the interaction
 * surface; salient turn boundaries (user prompts, assistant message ends,
 * tool executions) are mirrored into the session scope through the same WS
 * protocol the readline REPL uses. Deltas render to the console only — token
 * discipline: the ledger gets boundaries, not keystrokes.
 *
 * Provider configuration is Pi's own (~/.pi/agent) — Memex does not inject
 * keys into the Pi session; the two config layers stay separate (ADR-22).
 */

import { createInterface } from 'node:readline';
import type { MemexTerminalClient } from './client.js';

/** Truncate tool results before they enter the ledger (token discipline). */
export function truncateForLedger(value: unknown, max = 500): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…[+${s.length - max} chars]` : s;
}

export async function runAgentMode(client: MemexTerminalClient): Promise<void> {
  // Lazy import: readline mode must work without Pi SDK provider setup.
  const { createAgentSession } = await import('@earendil-works/pi-coding-agent');
  const { session } = await createAgentSession();

  console.log('agent mode — Pi session live; turn boundaries mirror to the graph');

  session.subscribe((evt) => {
    void (async () => {
      try {
        if (evt.type === 'message_update') {
          // render only — deltas never touch the ledger
          const e = evt.assistantMessageEvent as { type?: string; delta?: string };
          if (e?.type === 'text_delta' && typeof e.delta === 'string') process.stdout.write(e.delta);
          return;
        }
        if (evt.type === 'message_end') {
          process.stdout.write('\n');
          const m = evt.message as { role?: string; content?: unknown };
          if (m.role === 'assistant') {
            await client.recordEvent('memory_updated', {
              source: 'memex-terminal-agent',
              role: 'assistant',
              text: truncateForLedger(m.content, 2000),
            });
          }
          return;
        }
        if (evt.type === 'tool_execution_start') {
          console.log(`  ⚒ ${evt.toolName}`);
          return;
        }
        if (evt.type === 'tool_execution_end') {
          await client.recordEvent('memory_updated', {
            source: 'memex-terminal-agent',
            tool: evt.toolName,
            is_error: evt.isError,
            result: truncateForLedger(evt.result),
          });
        }
      } catch {
        /* mirroring is best-effort; the Pi session must never crash on a graph hiccup */
      }
    })();
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'memex(agent)> ' });
  rl.prompt();
  rl.on('line', (line) => {
    const text = line.trim();
    if (text === '/quit' || text === '/exit') {
      rl.close();
      return;
    }
    if (text.length === 0) {
      rl.prompt();
      return;
    }
    client
      // Pure graph MIRROR (trail = SSOT): recordEvent, NOT sendUserMessage —
      // in agent mode Pi is the responder; the ADR-54 conversation core must
      // not produce a second reply.
      .recordEvent('memory_updated', {
        kind: 'conversation.user',
        turn_id: crypto.randomUUID(),
        source: 'memex-terminal-agent',
        text,
      })
      .catch((err: unknown) => {
        // Mirror failure must not block the conversation — but never silently
        // (P3): the user deserves to know their trail is not being recorded.
        console.error('  ⚠ graph mirror failed:', err instanceof Error ? err.message : err);
      })
      .then(() => session.prompt(text))
      .catch((err: unknown) => {
        console.error('  ✗', err instanceof Error ? err.message : err);
      })
      .finally(() => rl.prompt());
  });

  await new Promise<void>((resolve) => {
    rl.on('close', () => {
      client.close();
      resolve();
    });
  });
}
