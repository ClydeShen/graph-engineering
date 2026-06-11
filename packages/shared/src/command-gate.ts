/**
 * Command safety gate. Ports hermes-agent HARDLINE + DANGEROUS patterns.
 *
 * checkCommand() is a pre-dispatch check for any tool that executes
 * user-supplied shell commands. HARDLINE = always blocked. DANGEROUS = blocked
 * until LLM approval (tier 3, deferred to Phase 6).
 *
 * Source: hermes tools/approval.py:203–427 adapted to graph-runtime context.
 * @see .harness/phases/04-plugs/04-plugs-PLAN.md Appendix A
 */

// ── Command-position fragment ──────────────────────────────────────────────
// Matches positions where a shell begins parsing a new command.
const CMDPOS =
  String.raw`(?:^|[;&|\n` + '`' + String.raw`]|\$\()` +
  String.raw`\s*(?:sudo\s+(?:-[^\s]+\s+)*)?` +
  String.raw`(?:env\s+(?:\w+=\S*\s+)*)?` +
  String.raw`(?:(?:exec|nohup|setsid|time)\s+)*\s*`;

// ── Sensitive path constants ───────────────────────────────────────────────
const SYSTEM_CONFIG_PATH = String.raw`(?:/etc/|/private/(?:etc|var|tmp|home)/)`;

// hermes _HERMES_ENV_PATH → adapted to MemexCore (~/.memex/)
const MEMEX_ENV_PATH =
  String.raw`(?:~\/\.memex/|(?:\$home|\$\{home\})/\.memex/)\.env\b`;

const SSH_SENSITIVE_PATH =
  String.raw`(?:~|\$home|\$\{home\})/\.ssh(?:/|$)`;

const PROJECT_ENV_PATH =
  String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'` + '`' + String.raw`]+/)*\.env(?:\.[^/\s"'` + '`' + String.raw`]+)*)`;

const PROJECT_CONFIG_PATH =
  String.raw`(?:(?:/|\.{1,2}/)?(?:[^\s/"'` + '`' + String.raw`]+/)*(?:config\.ya?ml|iii-config\.ya?ml))`;

const SHELL_RC_FILES =
  String.raw`(?:~|\$home|\$\{home\})/\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b`;

const CREDENTIAL_FILES =
  String.raw`(?:~|\$home|\$\{home\})/\.(?:netrc|pgpass|npmrc|pypirc)\b`;

const SENSITIVE_WRITE_TARGET =
  `(?:${SYSTEM_CONFIG_PATH}|/dev/sd|${SSH_SENSITIVE_PATH}|${MEMEX_ENV_PATH}|${SHELL_RC_FILES}|${CREDENTIAL_FILES})`;

const PROJECT_SENSITIVE_WRITE_TARGET =
  `(?:${PROJECT_ENV_PATH}|${PROJECT_CONFIG_PATH})`;

const COMMAND_TAIL = String.raw`(?:\s*(?:&&|\|\||;).*)?$`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface SecurityPattern {
  id: string;
  pattern: RegExp;
  description: string;
}

export type GateVerdict =
  | { allowed: true }
  | { allowed: false; tier: 'hardline' | 'dangerous'; reason: string; patternId: string };

// ── HARDLINE_PATTERNS: 12 patterns — always blocked ───────────────────────

export const HARDLINE_PATTERNS: Array<SecurityPattern> = [
  {
    id: 'rm-root',
    pattern: new RegExp(String.raw`\brm\s+(-[^\s]*\s+)*(\/|\/*\*|\/\s\*)(\s|$)`, 'i'),
    description: 'recursive delete of root filesystem',
  },
  {
    id: 'rm-system-dir',
    pattern: new RegExp(
      String.raw`\brm\s+(-[^\s]*\s+)*(/home|/root|/etc|/usr|/var|/bin|/sbin|/boot|/lib)(/?|/\*)?(\s|$)`,
      'i',
    ),
    description: 'recursive delete of system directory',
  },
  {
    id: 'rm-home',
    pattern: new RegExp(String.raw`\brm\s+(-[^\s]*\s+)*(~|\$home)(/?|/\*)?(\s|$)`, 'i'),
    description: 'recursive delete of home directory',
  },
  {
    id: 'mkfs',
    pattern: new RegExp(String.raw`\bmkfs(\.[a-z0-9]+)?\b`, 'i'),
    description: 'format filesystem (mkfs)',
  },
  {
    id: 'dd-block-device',
    pattern: new RegExp(String.raw`\bdd\b[^\n]*\bof=/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*`, 'i'),
    description: 'dd to raw block device',
  },
  {
    id: 'redirect-block-device',
    pattern: new RegExp(String.raw`>\s*/dev/(sd|nvme|hd|mmcblk|vd|xvd)[a-z0-9]*\b`, 'i'),
    description: 'redirect to raw block device',
  },
  {
    id: 'fork-bomb',
    pattern: new RegExp(String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, 'i'),
    description: 'fork bomb',
  },
  {
    id: 'kill-all',
    pattern: new RegExp(String.raw`\bkill\s+(-[^\s]+\s+)*-1\b`, 'i'),
    description: 'kill all processes (kill -1)',
  },
  {
    id: 'shutdown-reboot',
    pattern: new RegExp(`${CMDPOS}(shutdown|reboot|halt|poweroff)\\b`, 'i'),
    description: 'system shutdown/reboot',
  },
  {
    id: 'init-shutdown',
    pattern: new RegExp(`${CMDPOS}init\\s+[06]\\b`, 'i'),
    description: 'init 0/6 (shutdown/reboot)',
  },
  {
    id: 'systemctl-shutdown',
    pattern: new RegExp(`${CMDPOS}systemctl\\s+(poweroff|reboot|halt|kexec)\\b`, 'i'),
    description: 'systemctl poweroff/reboot/halt/kexec',
  },
  {
    id: 'telinit-shutdown',
    pattern: new RegExp(`${CMDPOS}telinit\\s+[06]\\b`, 'i'),
    description: 'telinit 0/6 (shutdown/reboot)',
  },
];

// ── DANGEROUS_PATTERNS: 54 patterns — blocked pending LLM approval ─────────

export const DANGEROUS_PATTERNS: Array<SecurityPattern> = [
  // Group 1 — rm/chmod/chown (7)
  {
    id: 'rm-root-path',
    pattern: new RegExp(String.raw`\brm\s+(-[^\s]*\s+)*/`, 'is'),
    description: 'delete in root path',
  },
  {
    id: 'rm-recursive',
    pattern: new RegExp(String.raw`\brm\s+-[^\s]*r`, 'is'),
    description: 'recursive delete',
  },
  {
    id: 'rm-recursive-long',
    pattern: new RegExp(String.raw`\brm\s+--recursive\b`, 'is'),
    description: 'recursive delete (long flag)',
  },
  {
    id: 'chmod-world-writable',
    pattern: new RegExp(String.raw`\bchmod\s+(-[^\s]*\s+)*(777|666|o\+[rwx]*w|a\+[rwx]*w)\b`, 'is'),
    description: 'world/other-writable permissions',
  },
  {
    id: 'chmod-world-writable-long',
    pattern: new RegExp(String.raw`\bchmod\s+--recursive\b.*(777|666|o\+[rwx]*w|a\+[rwx]*w)`, 'is'),
    description: 'recursive world-writable (long flag)',
  },
  {
    id: 'chown-root-recursive',
    pattern: new RegExp(String.raw`\bchown\s+(-[^\s]*)?R\s+root`, 'is'),
    description: 'recursive chown to root',
  },
  {
    id: 'chown-root-recursive-long',
    pattern: new RegExp(String.raw`\bchown\s+--recursive\b.*root`, 'is'),
    description: 'recursive chown to root (long flag)',
  },

  // Group 2 — disk ops (3)
  {
    id: 'mkfs-any',
    pattern: new RegExp(String.raw`\bmkfs\b`, 'is'),
    description: 'format filesystem',
  },
  {
    id: 'dd-copy',
    pattern: new RegExp(String.raw`\bdd\s+.*if=`, 'is'),
    description: 'disk copy',
  },
  {
    id: 'redirect-raw-block',
    pattern: new RegExp(String.raw`>\s*/dev/sd`, 'is'),
    description: 'write to raw block device',
  },

  // Group 3 — SQL destructive ops (3)
  {
    id: 'sql-drop',
    pattern: new RegExp(String.raw`\bDROP\s+(TABLE|DATABASE)\b`, 'is'),
    description: 'SQL DROP TABLE/DATABASE',
  },
  {
    id: 'sql-delete-no-where',
    pattern: new RegExp(String.raw`\bDELETE\s+FROM\b(?![^\n]*\bWHERE\b)`, 'is'),
    description: 'SQL DELETE without WHERE',
  },
  {
    id: 'sql-truncate',
    pattern: new RegExp(String.raw`\bTRUNCATE\s+(TABLE\s+)?\w`, 'is'),
    description: 'SQL TRUNCATE',
  },

  // Group 4 — system config write (1)
  {
    id: 'redirect-system-config',
    pattern: new RegExp(`>\\s*${SYSTEM_CONFIG_PATH}`, 'is'),
    description: 'overwrite system config via redirect',
  },

  // Group 5 — systemctl / kill (3)
  {
    id: 'systemctl-stop-service',
    pattern: new RegExp(String.raw`\bsystemctl\s+(-[^\s]+\s+)*(stop|restart|disable|mask)\b`, 'is'),
    description: 'stop/restart/disable/mask service',
  },
  {
    id: 'kill-all-9',
    pattern: new RegExp(String.raw`\bkill\s+-9\s+-1\b`, 'is'),
    description: 'kill all processes (kill -9 -1)',
  },
  {
    id: 'pkill-force',
    pattern: new RegExp(String.raw`\bpkill\s+-9\b`, 'is'),
    description: 'force-kill processes (pkill -9)',
  },

  // Group 6 — killall variants (3)
  {
    id: 'killall-kill',
    pattern: new RegExp(String.raw`\bkillall\s+(-[^\s]*\s+)*-(9|KILL|SIGKILL)\b`, 'is'),
    description: 'killall -KILL / -9 / -SIGKILL',
  },
  {
    id: 'killall-s-kill',
    pattern: new RegExp(String.raw`\bkillall\s+(-[^\s]*\s+)*-s\s+(KILL|SIGKILL|9)\b`, 'is'),
    description: 'killall -s KILL',
  },
  {
    id: 'killall-regex',
    pattern: new RegExp(String.raw`\bkillall\s+(-[^\s]*\s+)*-r\b`, 'is'),
    description: 'killall by regex (-r broad sweep)',
  },

  // Group 7 — fork bomb + shell exec (6)
  {
    id: 'fork-bomb-dangerous',
    pattern: new RegExp(String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`, 'is'),
    description: 'fork bomb',
  },
  {
    id: 'shell-c-flag',
    pattern: new RegExp(String.raw`\b(bash|sh|zsh|ksh)\s+-[^\s]*c(\s+|$)`, 'is'),
    description: 'shell command via -c/-lc flag',
  },
  {
    id: 'script-e-c-flag',
    pattern: new RegExp(String.raw`\b(python[23]?|perl|ruby|node)\s+-[ec]\s+`, 'is'),
    description: 'script execution via -e/-c flag',
  },
  {
    id: 'pipe-to-shell',
    pattern: new RegExp(String.raw`\b(curl|wget)\b.*\|\s*(?:[/\w]*/)?(?:ba)?sh(?:\s|$|-c)`, 'is'),
    description: 'pipe remote content to shell',
  },
  {
    id: 'process-substitution-shell',
    pattern: new RegExp(String.raw`\b(bash|sh|zsh|ksh)\s+<\s*<?\s*\(\s*(curl|wget)\b`, 'is'),
    description: 'remote script via process substitution',
  },
  {
    id: 'heredoc-exec',
    pattern: new RegExp(String.raw`\b(python[23]?|perl|ruby|node)\s+<<`, 'is'),
    description: 'script execution via heredoc',
  },

  // Group 8 — sensitive file write (4)
  {
    id: 'tee-sensitive-file',
    pattern: new RegExp(`\\btee\\b.*${SENSITIVE_WRITE_TARGET}`, 'is'),
    description: 'overwrite system/sensitive file via tee',
  },
  {
    id: 'redirect-sensitive-file',
    pattern: new RegExp(`>>?\\s*${SENSITIVE_WRITE_TARGET}`, 'is'),
    description: 'overwrite system/sensitive file via redirect',
  },
  {
    id: 'tee-project-config',
    pattern: new RegExp(`\\btee\\b.*${PROJECT_SENSITIVE_WRITE_TARGET}${COMMAND_TAIL}`, 'is'),
    description: 'overwrite project env/config via tee',
  },
  {
    id: 'redirect-project-config',
    pattern: new RegExp(`>>?\\s*${PROJECT_SENSITIVE_WRITE_TARGET}${COMMAND_TAIL}`, 'is'),
    description: 'overwrite project env/config via redirect',
  },

  // Group 9 — xargs / find (3)
  {
    id: 'xargs-rm',
    pattern: new RegExp(String.raw`\bxargs\s+.*\brm\b`, 'is'),
    description: 'xargs with rm',
  },
  {
    id: 'find-exec-rm',
    pattern: new RegExp(String.raw`\bfind\b.*-exec(?:dir)?\s+(/\S*/)?rm\b`, 'is'),
    description: 'find -exec/-execdir rm',
  },
  {
    id: 'find-delete',
    pattern: new RegExp(String.raw`\bfind\b.*-delete\b`, 'is'),
    description: 'find -delete',
  },

  // Group 10 — graph-runtime process protection (6)
  {
    id: 'graph-runtime-stop',
    pattern: new RegExp(String.raw`\bgraph-runtime\s+(stop|restart)\b`, 'is'),
    description: 'stop/restart graph-runtime process',
  },
  {
    id: 'graph-runtime-update',
    pattern: new RegExp(String.raw`\bgraph-runtime\s+update\b`, 'is'),
    description: 'graph-runtime update (restarts process)',
  },
  {
    id: 'docker-compose-lifecycle',
    pattern: new RegExp(String.raw`\bdocker\s+compose\s+(restart|stop|kill|down)\b`, 'is'),
    description: 'docker compose lifecycle',
  },
  {
    id: 'docker-container-lifecycle',
    pattern: new RegExp(String.raw`\bdocker\s+(restart|stop|kill)\b`, 'is'),
    description: 'docker container lifecycle',
  },
  {
    id: 'gateway-run-background',
    pattern: new RegExp(String.raw`gateway\s+run\b.*(&\s*$|&\s*;|\bdisown\b|\bsetsid\b)`, 'is'),
    description: 'start gateway outside systemd',
  },
  {
    id: 'nohup-gateway',
    pattern: new RegExp(String.raw`\bnohup\b.*gateway\s+run\b`, 'is'),
    description: 'nohup gateway run',
  },

  // Group 11 — self-termination protection (3)
  {
    id: 'kill-graph-process',
    pattern: new RegExp(String.raw`\b(pkill|killall)\b.*\b(graph-workers|graph-gateway)\b`, 'is'),
    description: 'kill graph process (self-termination)',
  },
  {
    id: 'kill-pgrep-expansion',
    pattern: new RegExp(String.raw`\bkill\b.*\$\(\s*pgrep\b`, 'is'),
    description: 'kill via pgrep expansion',
  },
  {
    id: 'kill-backtick-pgrep',
    pattern: new RegExp(String.raw`\bkill\b.*` + '`' + String.raw`\s*pgrep\b`, 'is'),
    description: 'kill via backtick pgrep',
  },

  // Group 12 — cp/mv/sed to system paths (4)
  {
    id: 'cp-mv-system-config',
    pattern: new RegExp(`\\b(cp|mv|install)\\b.*\\s${SYSTEM_CONFIG_PATH}`, 'is'),
    description: 'copy/move file into system config path',
  },
  {
    id: 'cp-mv-project-config',
    pattern: new RegExp(`\\b(cp|mv|install)\\b.*\\s${PROJECT_SENSITIVE_WRITE_TARGET}${COMMAND_TAIL}`, 'is'),
    description: 'overwrite project env/config file',
  },
  {
    id: 'sed-inplace-system',
    pattern: new RegExp(`\\bsed\\s+-[^\\s]*i.*\\s${SYSTEM_CONFIG_PATH}`, 'is'),
    description: 'in-place edit of system config',
  },
  {
    id: 'sed-inplace-system-long',
    pattern: new RegExp(`\\bsed\\s+--in-place\\b.*\\s${SYSTEM_CONFIG_PATH}`, 'is'),
    description: 'in-place edit of system config (long flag)',
  },

  // Group 13 — git destructive ops (5)
  {
    id: 'git-reset-hard',
    pattern: new RegExp(String.raw`\bgit\s+reset\s+--hard\b`, 'is'),
    description: 'git reset --hard (destroys uncommitted changes)',
  },
  {
    id: 'git-force-push',
    pattern: new RegExp(String.raw`\bgit\s+push\b.*--force\b`, 'is'),
    description: 'git force push (rewrites remote history)',
  },
  {
    id: 'git-force-push-short',
    pattern: new RegExp(String.raw`\bgit\s+push\b.*-f\b`, 'is'),
    description: 'git force push short flag',
  },
  {
    id: 'git-clean-force',
    pattern: new RegExp(String.raw`\bgit\s+clean\s+-[^\s]*f`, 'is'),
    description: 'git clean with force (deletes untracked files)',
  },
  {
    id: 'git-branch-delete',
    pattern: new RegExp(String.raw`\bgit\s+branch\s+-D\b`, 'is'),
    description: 'git branch force delete',
  },

  // Group 14 — chmod+x + sudo privilege (3)
  {
    id: 'chmod-x-exec',
    pattern: new RegExp(String.raw`\bchmod\s+\+x\b.*[;&|]+\s*\.\/`, 'is'),
    description: 'chmod +x followed by immediate execution',
  },
  {
    id: 'sudo-stdin-flag',
    pattern: new RegExp(String.raw`\bsudo\b[^;\|&\n]*?\s+(?:-s\b|--stdin\b|-a\b|--askpass\b)`, 'is'),
    description: 'sudo with stdin/askpass/shell privilege flag',
  },
  {
    id: 'sudo-combined-privilege',
    pattern: new RegExp(String.raw`\bsudo\b[^;\|&\n]*?\s+-[a-z]*[sa][a-z]*\b`, 'is'),
    description: 'sudo combined-flag privilege escalation',
  },
];

// ── checkCommand ───────────────────────────────────────────────────────────

export function checkCommand(command: string): GateVerdict {
  const normalized = command.toLowerCase().trim().replace(/\s+/g, ' ');
  for (const { id, pattern, description } of HARDLINE_PATTERNS) {
    if (pattern.test(normalized)) return { allowed: false, tier: 'hardline', reason: description, patternId: id };
  }
  for (const { id, pattern, description } of DANGEROUS_PATTERNS) {
    if (pattern.test(normalized)) return { allowed: false, tier: 'dangerous', reason: description, patternId: id };
  }
  return { allowed: true };
}
