/**
 * B2 — the "skill needs a backing CLI" precondition (GH #24, naturally-occurring
 * quirk). Unlike the §5 microservice DAG, whose dependency edges are enforced by a
 * synthetic isReady() table, here the precondition is enforced by REALITY: the skill
 * command genuinely is not on PATH until it is installed, so attempting to use it
 * returns a real "command not found". The hidden rule the loop must learn is
 * "install the CLI before using the skill" — the exact shape of the real
 * agent-browser pit (its SKILL.md is a discovery stub that defers to a binary that
 * must be installed first; without it, `agent-browser skills get core` → not found).
 *
 * Controlled instance (the §5 methodology: faithful mechanism, controlled instance):
 * the CLI is a tiny local stub installed by writing a script onto a temp PATH dir,
 * with no network. State is real (presence on PATH) and is reset between runs so the
 * ONLY thing that carries over is the crystallized lesson, never the installed binary.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';

/** The two actions the agent can take. The agent must LEARN that install precedes use. */
export const ACTIONS = ['install_cli', 'use_skill'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Relative, forward-slash path (anchored at the repo-root cwd). The stub is a node
 * script invoked via process.execPath, not a PATH-resolved shell command: a Windows
 * tmpdir path is unparseable on the MSYS PATH, and the Node harness cannot spawn
 * /bin/sh on Windows. process.execPath is always valid, and running a missing script
 * genuinely errors (the precondition is enforced by the file's real presence, not by
 * a synthetic gate) — the same shape as a real "command not found".
 */
export const BIN_DIR = '.harness/tmp/cli-precondition';
const STUB_PATH = `${BIN_DIR}/s-cli.mjs`;

/**
 * The skill's SKILL.md as injected into the agent — a DISCOVERY STUB, mirroring
 * agent-browser's. It presents the tool as ready to use; it does NOT mention
 * installation. The precondition (install before use) is therefore HIDDEN: a cold
 * agent's natural move is to run the command, not to install something it assumes is
 * already present. Only by failing does it discover the install step. Leaking the
 * precondition here (e.g. "install first if not found") would make a cold agent
 * install proactively and there would be nothing to learn — the §5.5 trap.
 */
export const SKILL_STUB =
  '# s-cli (data tool)\n' +
  'The `s-cli` data tool prints the project status report.\n' +
  'Run `s-cli report` to get it.';

export const GOAL_TEXT =
  'Produce the project status report by running the s-cli data tool. ' +
  'Primary action: "use_skill" (runs `s-cli report`). If an action fails, you also ' +
  'have an "install_cli" action available. The job is done when the report runs ' +
  'successfully. Choose ONE action per turn.';

/** Install the stub CLI (the effect of the install_cli action). Idempotent, no network. */
export function installCli(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(STUB_PATH, "console.log('[s-cli] status: green');\n", 'utf8');
}

/** Reset: remove the stub so the next run starts with the CLI absent (lesson persists, binary does not). */
export function resetCli(): void {
  rmSync(STUB_PATH, { force: true });
}

export function isCliInstalled(): boolean {
  return existsSync(STUB_PATH);
}

/**
 * Run the real command for an action and report success. use_skill runs `s-cli report`
 * through a real shell against the real PATH, so it genuinely fails with a non-zero
 * "command not found" when the stub is absent. This is the faithful difference from
 * §5: the precondition is enforced by the environment, not by a synthetic gate the
 * harness consults.
 */
export function runAction(action: Action): { ok: boolean; detail: string } {
  try {
    if (action === 'install_cli') {
      installCli();
      return { ok: true, detail: 'installed s-cli' };
    }
    // Invoke the stub via node; running a missing script genuinely errors when absent.
    const out = execFileSync(process.execPath, [STUB_PATH, 'report'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, detail: out.toString().trim() };
  } catch (e) {
    const msg = (e as { stderr?: Buffer; message?: string }).stderr?.toString() || (e as Error).message;
    return { ok: false, detail: (msg || 'command not found').trim().split('\n')[0] ?? 'failed' };
  }
}
