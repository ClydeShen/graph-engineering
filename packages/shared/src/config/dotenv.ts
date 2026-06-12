/**
 * Minimal .env loader (ADR 56 D-5) — single implementation shared by the CLI
 * entry and any other Node entry point that should see the repo-root .env
 * (dev.mjs keeps its own inline copy because it runs before workspaces resolve).
 *
 * Semantics match dev.mjs: KEY=VALUE lines, optional surrounding quotes
 * stripped, no expansion. Existing process.env keys are NEVER overwritten
 * (process env > .env > config.json — ADR 56 priority chain).
 */

import { existsSync, readFileSync } from 'node:fs';

/** Parse a dotenv-format string into key/value pairs. */
export function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_]\w*)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

/**
 * Load `.env` from cwd (or a given path) into `env`, without overwriting
 * keys that are already set. Returns the keys actually applied.
 */
export function loadDotenv(
  path = '.env',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!existsSync(path)) return [];
  const parsed = parseDotenv(readFileSync(path, 'utf8'));
  const applied: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined) {
      env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
