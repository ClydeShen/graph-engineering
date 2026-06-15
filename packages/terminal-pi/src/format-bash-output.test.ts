import { describe, it, expect } from 'vitest';
import { formatBashOutput } from './bash-output.js';

describe('formatBashOutput', () => {
  it('returns clean stdout with real newlines (not escaped JSON)', () => {
    const raw = JSON.stringify({ stdout: 'line1\nline2\n', stderr: '', exit_code: 0, backend: 'local' });
    const out = formatBashOutput(raw);
    expect(out).toBe('line1\nline2');
    expect(out).not.toContain('\\n');
    expect(out).not.toContain('stdout');
  });

  it('appends stderr and non-zero exit compactly', () => {
    const raw = JSON.stringify({ stdout: 'partial', stderr: 'boom', exit_code: 2, backend: 'local' });
    const out = formatBashOutput(raw);
    expect(out).toContain('partial');
    expect(out).toContain('stderr: boom');
    expect(out).toContain('exit 2');
  });

  it('omits exit line on success', () => {
    const out = formatBashOutput(JSON.stringify({ stdout: 'ok', stderr: '', exit_code: 0, backend: 'local' }));
    expect(out).toBe('ok');
  });

  it('reports a no-output run', () => {
    expect(formatBashOutput(JSON.stringify({ stdout: '', stderr: '', exit_code: 0, backend: 'local' }))).toBe('(no output)');
  });

  it('surfaces an error payload', () => {
    expect(formatBashOutput(JSON.stringify({ error: 'docker missing', backend: 'docker' }))).toBe('error: docker missing');
  });

  it('passes through non-JSON text unchanged', () => {
    expect(formatBashOutput('blocked by gate')).toBe('blocked by gate');
  });
});
