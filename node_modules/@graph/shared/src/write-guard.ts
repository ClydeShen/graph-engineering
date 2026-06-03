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
