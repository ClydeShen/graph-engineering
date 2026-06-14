/**
 * Workspace folder roots (CONSOLE-REDESIGN §11.1 / §11.4).
 *
 * A workspace is a plain working folder — "sugar over discovered folder
 * clusters, no registry". onboarding seeds one root per channel/agent so each
 * channel's work has a home folder that naturally becomes its scope `project`
 * (the cwd execute_bash records, §11.1). Each root carries an AGENTS.md (AGENTS
 * interop, so external agent tooling recognises it) and an `artifacts/` subdir.
 *
 * Idempotent: existing folders and a user's own AGENTS.md are never overwritten.
 * Hard-deleting a root later is the §11.3 lazy-tombstone path (graph unchanged).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { profileDir } from './config/loader.js';

/** Root holding all per-channel workspace folders for the active profile. */
export function workspacesRoot(base: string = profileDir()): string {
  return join(base, 'workspaces');
}

/**
 * Create (idempotently) one workspace folder root and return its path. Seeds an
 * `artifacts/` subdir and an AGENTS.md placeholder when absent.
 */
export function ensureWorkspaceRoot(name: string, base?: string): string {
  const dir = join(workspacesRoot(base), name);
  mkdirSync(join(dir, 'artifacts'), { recursive: true });
  const agentsMd = join(dir, 'AGENTS.md');
  if (!existsSync(agentsMd)) {
    writeFileSync(
      agentsMd,
      `# ${name} workspace\n\n` +
        `Working folder for the \`${name}\` agent (per-channel identity, ` +
        `CONSOLE-REDESIGN §11). Files produced here are grouped under this ` +
        `project in the Console Workspace view. Delete this folder to archive ` +
        `the project (the trail is never rewritten).\n`,
      'utf8',
    );
  }
  return dir;
}

/** Create workspace roots for several channels/agents at once (idempotent). */
export function ensureWorkspaceRoots(names: string[], base?: string): string[] {
  return [...new Set(names)].map((n) => ensureWorkspaceRoot(n, base));
}
