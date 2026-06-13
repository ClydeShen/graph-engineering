/**
 * memex console — open the dashboard (the Next.js Console UI on :3000) in the
 * browser. If it's already serving we open it immediately; otherwise we start
 * the dev stack by delegating to `npm run dev` (never reimplementing it) and
 * open the browser the moment :3000 answers.
 *
 * The Console needs the whole stack (gateway + workers + DB), which is exactly
 * what `npm run dev` brings up — so "start" means that, not a bare Next server.
 */

import { spawn } from 'node:child_process';
import { openUrl } from './wsl.js';

const CONSOLE_URL = 'http://localhost:3000';

/** True when something answers OK at the URL within the timeout. */
async function isUp(url: string, timeoutMs = 1200): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function runConsoleCommand(): Promise<void> {
  if (await isUp(CONSOLE_URL)) {
    console.log(`Console is up — opening ${CONSOLE_URL}`);
    openUrl(CONSOLE_URL);
    return;
  }

  console.log('Console not running — starting the stack (npm run dev)…');
  console.log('(run this from the repo root; press Ctrl-C to stop everything)\n');
  // Delegate to the canonical launcher; inherit stdio so logs stream and the
  // MemexTerminal handoff keeps working on this terminal.
  const child = spawn('npm', ['run', 'dev'], { stdio: 'inherit', shell: true });

  // Poll for the Console in the background and pop the browser once it answers.
  void (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      if (await isUp(CONSOLE_URL)) {
        console.log(`\nConsole is live — opening ${CONSOLE_URL}`);
        openUrl(CONSOLE_URL);
        return;
      }
    }
  })();

  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
}
