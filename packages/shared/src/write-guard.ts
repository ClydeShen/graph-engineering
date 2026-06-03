const REDACTIONS: Array<[RegExp, string]> = [
  [/sk-[A-Za-z0-9]{32,}/g, '[REDACTED:api_key]'],
  [/AKIA[0-9A-Z]{16}/g, '[REDACTED:aws_key]'],
  [/postgres(?:ql)?:\/\/[^\s"']+/g, '[REDACTED:pg_conn]'],
  [/<secret>[^<]*<\/secret>/g, '[REDACTED:secret_type]'],
];

export function writeGuard(payload: string): string {
  let result = payload;
  for (const [pattern, replacement] of REDACTIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
