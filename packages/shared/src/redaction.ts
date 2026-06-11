// ---------------------------------------------------------------------------
// writeGuard — scrubs secrets from strings before LLM input
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  // OpenAI (sk-...) and Anthropic (sk-ant-...) API keys
  [/sk-(?:ant-)?[A-Za-z0-9\-_]{32,}/g, '[REDACTED:api_key]'],
  // AWS access key IDs
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws_key]'],
  // PostgreSQL / MySQL connection strings
  [/(?:postgres(?:ql)?|mysql):\/\/[^\s"']+/g, '[REDACTED:pg_conn]'],
  // Explicit <secret> tags
  [/<secret>[^<]*<\/secret>/g, '[REDACTED:secret_type]'],
];

export function writeGuard(payload: string): string {
  let result = payload;
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ---------------------------------------------------------------------------
// redactPii — known-PII patterns (ADR-47 D-6, hermes privacy.redact_pii parity)
//
// Deliberately SEPARATE from writeGuard: secrets are always scrubbed; PII
// redaction applies at pii_safe channel boundaries and LLM-send points only —
// blanket application would break channels whose content legitimately carries
// addresses (the email connector). Write-time prevention; erasure (ADR-43) is
// the post-hoc remedy.
// ---------------------------------------------------------------------------

const PII_REDACTIONS: Array<[RegExp, string]> = [
  // Email addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED:email]'],
  // IPv4 addresses — MUST run before the phone pattern (dotted digit runs
  // would otherwise be consumed as phone numbers)
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED:ip]'],
  // International-ish phone numbers (7+ digits with separators, optional +CC)
  [/\+?\d[\d\s().-]{6,}\d/g, '[REDACTED:phone]'],
];

export function redactPii(payload: string): string {
  let result = payload;
  for (const [pattern, replacement] of PII_REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
