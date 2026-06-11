/**
 * Two-stage subprocess env filtering + write denylist (ADR-47 D-5, hermes
 * code_execution_tool parity). Shared by the local and docker execution
 * backends — one implementation, no drift.
 *
 * Stage 1 (denylist): any var whose NAME contains a secret substring is dropped.
 * Stage 2 (allowlist): of the survivors, only safe-prefixed vars pass.
 *
 * This is defense-in-depth, NOT a security boundary (ADR-47 preamble).
 */

const SECRET_SUBSTRINGS = [
  'KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'PASSWD', 'AUTH', 'DSN', 'WEBHOOK',
] as const;

const SAFE_ENV_PREFIXES = [
  'PATH', 'HOME', 'USER', 'LANG', 'LC_', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
  'SHELL', 'PWD', 'HOSTNAME', 'TZ',
  // Windows process basics
  'SYSTEMROOT', 'COMSPEC', 'WINDIR', 'OS', 'NUMBER_OF_PROCESSORS',
] as const;

/**
 * Vars an agent may NEVER set on a subprocess (loader/path hijack vectors,
 * hermes config.py:116 pattern). Checked by name, case-insensitive.
 */
export const ENV_WRITE_DENYLIST = [
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES',
  'PYTHONPATH', 'NODE_OPTIONS', 'PATH', 'PERL5LIB', 'RUBYLIB',
] as const;

export function filterSubprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    // Stage 1: secret-substring denylist
    if (SECRET_SUBSTRINGS.some((s) => upper.includes(s))) continue;
    // Stage 2: safe-prefix allowlist
    if (!SAFE_ENV_PREFIXES.some((p) => upper.startsWith(p))) continue;
    out[name] = value;
  }
  return out;
}

/** True when an agent-supplied env assignment must be refused. */
export function isEnvWriteDenied(name: string): boolean {
  const upper = name.toUpperCase();
  return ENV_WRITE_DENYLIST.some((d) => d === upper);
}
