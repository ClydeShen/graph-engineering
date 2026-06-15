import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { buildOutcomeLines, type OutcomeStatus } from './outcome.js';

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe('buildOutcomeLines', () => {
  it('renders a copy-clean panel (no vertical borders)', () => {
    const lines = buildOutcomeLines(theme, 50, { status: 'denied', title: 'command denied' });
    for (const l of lines) expect(l).not.toContain('│');
  });

  it('carries the status word in the header', () => {
    const lines = buildOutcomeLines(theme, 50, { status: 'complete', title: 'done' });
    expect(lines[0]).toContain('done');
    expect(lines[0]).toContain('✓');
  });

  it('shows subject verbatim and a Next action', () => {
    const lines = buildOutcomeLines(theme, 60, {
      status: 'denied',
      title: 'command denied',
      subject: 'rm -rf /tmp/x',
      next: 'It did not run. Approve manually if intended.',
    });
    const joined = lines.join('\n');
    expect(joined).toContain('rm -rf /tmp/x');
    expect(joined).toContain('Next');
    expect(joined).toContain('Approve manually');
  });

  it('maps each status to its icon', () => {
    const icon = (s: OutcomeStatus) => buildOutcomeLines(theme, 40, { status: s, title: s })[0];
    expect(icon('complete')).toContain('✓');
    expect(icon('blocked')).toContain('!');
    expect(icon('denied')).toContain('✗');
    expect(icon('failed')).toContain('✗');
  });

  it('wraps a long detail within the width', () => {
    const long = 'this is a fairly long explanation that should wrap across multiple lines without overflowing the panel width at all';
    const lines = buildOutcomeLines(theme, 40, { status: 'blocked', title: 'blocked', detail: long });
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(40);
    expect(lines.length).toBeGreaterThan(3);
  });
});
