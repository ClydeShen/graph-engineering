/**
 * memex log — read the dev-stack inspection hatch.
 *
 * dev.mjs mirrors every component line (iii, workers, control-plane, gateway,
 * console) into ~/.memex/logs/dev.log, ANSI-stripped and append-only. The
 * interactive boot drops the user into MemexTerminal, NOT this firehose
 * (ADR 56 D-5 first-run experience) — so the raw iii/component logs live here,
 * opened explicitly with `memex log` only when the user wants to inspect them.
 *
 *   memex log            tail the last 200 lines, then follow
 *   memex log -n 50      tail the last 50 lines, then follow
 *   memex log --no-follow print the recent lines and exit (scriptable)
 */

import { existsSync, statSync, openSync, readSync, closeSync, watch } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_TAIL_LINES = 200;

/** The dev-stack log sink — global (matches scripts/dev.mjs), not profile-scoped. */
export function devLogPath(): string {
  return join(homedir(), '.memex', 'logs', 'dev.log');
}

function argFlagValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Read the whole file and return its last `n` lines plus the byte length read. */
function readLastLines(path: string, n: number): { lines: string[]; size: number } {
  const size = statSync(path).size;
  if (size === 0) return { lines: [], size };
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    const text = buf.toString('utf8');
    const all = text.split(/\r?\n/);
    // A trailing newline yields a final '' element — drop it so we don't print a blank.
    if (all.length > 0 && all[all.length - 1] === '') all.pop();
    return { lines: all.slice(-n), size };
  } finally {
    closeSync(fd);
  }
}

export async function runLogCommand(): Promise<void> {
  const path = devLogPath();
  if (!existsSync(path)) {
    console.error(
      `no dev log yet at ${path}\nstart the stack first (npm run dev), then: memex log`,
    );
    process.exit(1);
  }

  const nArg = argFlagValue('-n') ?? argFlagValue('--lines');
  const tailLines = nArg !== undefined && Number.isInteger(Number(nArg)) ? Number(nArg) : DEFAULT_TAIL_LINES;
  const follow = !process.argv.includes('--no-follow');

  const { lines, size } = readLastLines(path, tailLines);
  for (const line of lines) console.log(line);

  if (!follow) return;

  // Follow: print bytes appended past `offset`. Poll the size (fs.watch alone
  // is unreliable on Windows/network drives); fs.watch only nudges the poll.
  let offset = size;
  const drain = (): void => {
    let nextSize: number;
    try {
      nextSize = statSync(path).size;
    } catch {
      return;
    }
    if (nextSize < offset) offset = 0; // truncated/rotated (new dev boot)
    if (nextSize === offset) return;
    const fd = openSync(path, 'r');
    try {
      const len = nextSize - offset;
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, offset);
      offset += read;
      process.stdout.write(buf.subarray(0, read).toString('utf8'));
    } finally {
      closeSync(fd);
    }
  };

  const timer = setInterval(drain, 400);
  try {
    watch(path, drain);
  } catch {
    /* fs.watch unsupported here — the 400ms poll still follows */
  }
  console.error('— following dev.log (Ctrl+C to stop) —');
  // Keep the process alive until the user interrupts.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => {
      clearInterval(timer);
      resolve();
    });
  });
}
