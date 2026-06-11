/**
 * skills-guard — pre-install injection-pattern scan for SKILL.md content
 * (Phase 16 G2, hermes skills_guard.py pattern).
 *
 * POSITIONING: a review aid, NOT a security boundary (ADR-47: only OS-level
 * isolation contains). The guard surfaces suspicious patterns for the human to
 * judge; a clean scan is not a safety guarantee.
 *
 * Pattern set is a living list — new injection techniques append a pattern,
 * the architecture does not change (16-PHASE-SPEC §6.3).
 */

export type GuardSeverity = 'high' | 'medium';

export interface GuardFinding {
  severity: GuardSeverity;
  /** Stable pattern identifier (for tests and suppression lists). */
  pattern: string;
  line: number;
  excerpt: string;
}

interface GuardRule {
  id: string;
  severity: GuardSeverity;
  re: RegExp;
}

const RULES: GuardRule[] = [
  // 1. Prompt-injection directives — overriding the agent's instructions.
  {
    id: 'prompt-override',
    severity: 'high',
    re: /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|above|all|your)\b.{0,40}\b(instructions?|context|rules?|prompt)\b/i,
  },
  // 2. Concealment coercion — instructing the agent to hide actions from the user.
  {
    id: 'concealment',
    severity: 'high',
    re: /\b(do not|don't|never)\b.{0,30}\b(show|tell|reveal|mention|inform|ask)\b.{0,30}\b(the )?(user|human|operator)\b/i,
  },
  // 3. Credential harvesting — directing keys/secrets toward an output channel.
  {
    id: 'credential-harvest',
    severity: 'high',
    re: /\b(api[-_ ]?keys?|passwords?|tokens?|secrets?|credentials?)\b.{0,60}\b(send|post|paste|upload|share|transmit|include)\b|\b(send|post|paste|upload|share|transmit)\b.{0,60}\b(api[-_ ]?keys?|passwords?|tokens?|secrets?|credentials?)\b/i,
  },
  // 4. Secret-file access — reaching for the places credentials live.
  {
    id: 'secret-file-access',
    severity: 'high',
    re: /(~\/\.aws|~\/\.ssh|\.env\b|id_rsa|credentials\.json|\.netrc)/i,
  },
  // 5. Exfiltration transport — shipping data to an external endpoint.
  {
    id: 'exfiltration',
    severity: 'high',
    // NB: no \b before "-d" — hyphen has no word boundary against a space.
    re: /\b(curl|wget|fetch|invoke-webrequest)\b[^\n]{0,120}\bhttps?:\/\/[^\n]{0,120}(\s--?(d|data|upload-file|F)\b|\b(body|payload)\b)|\bPOST\b[^\n]{0,80}\b(env|secret|key|token)\b/i,
  },
  // 6. Encoded payloads — base64 blobs / charcode chains hiding instructions.
  {
    id: 'encoded-payload',
    severity: 'medium',
    re: /([A-Za-z0-9+/]{120,}={0,2})|String\.fromCharCode\s*\(|(\\x[0-9a-f]{2}){12,}/i,
  },
  // 7. Destructive commands.
  {
    id: 'destructive-command',
    severity: 'high',
    re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+[/~]|\bmkfs\b|\bdd\s+[^\n]*of=\/dev\/|format\s+c:/i,
  },
  // 8. Loader hijack — env vars that change what code gets executed
  //    (mirrors the ENV_WRITE_DENYLIST enforced at runtime, ADR-47).
  {
    id: 'env-hijack',
    severity: 'medium',
    re: /\b(LD_PRELOAD|PYTHONPATH|NODE_OPTIONS|DYLD_INSERT_LIBRARIES)\s*=/,
  },
];

/** Scan SKILL.md content. Returns findings ordered by line number. */
export function scanSkillContent(content: string): GuardFinding[] {
  const findings: GuardFinding[] = [];
  const lines = content.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (rule.re.test(line)) {
        findings.push({
          severity: rule.severity,
          pattern: rule.id,
          line: i + 1,
          excerpt: line.length > 120 ? line.slice(0, 117) + '…' : line,
        });
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

export function formatGuardReport(findings: GuardFinding[]): string {
  if (findings.length === 0) {
    return '  guard: no suspicious patterns (review aid only — not a safety guarantee)';
  }
  const lines = findings.map(
    (f) => `  [${f.severity.toUpperCase()}] L${f.line} ${f.pattern}: ${f.excerpt}`,
  );
  lines.push('', `  ${findings.length} finding(s) — review before trusting this skill`);
  return lines.join('\n');
}
