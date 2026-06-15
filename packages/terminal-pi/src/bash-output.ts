/**
 * Render a runExecuteBash result for the terminal: real stdout with real
 * newlines, not the raw `{"stdout":"...\n...","exit_code":0}` JSON (which pi would
 * print verbatim, escapes and all). stderr / non-zero exit are appended compactly.
 * Cleaner for the human AND more natural for the model.
 *
 * A leaf module (no heavy imports) so it stays trivially unit-testable.
 */
export function formatBashOutput(raw: string): string {
  let j: { stdout?: string; stderr?: string; exit_code?: number; error?: string };
  try {
    j = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (typeof j.error === 'string') return `error: ${j.error}`;
  const parts: string[] = [];
  const out = (j.stdout ?? '').trimEnd();
  if (out) parts.push(out);
  const err = (j.stderr ?? '').trimEnd();
  if (err) parts.push(`stderr: ${err}`);
  if (typeof j.exit_code === 'number' && j.exit_code !== 0) parts.push(`exit ${j.exit_code}`);
  return parts.join('\n') || '(no output)';
}
