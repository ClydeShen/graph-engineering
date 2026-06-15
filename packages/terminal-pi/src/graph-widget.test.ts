import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { buildWidgetLines, nextDensity, type Density } from './graph-widget.js';
import type { GraphSnapshot } from './graph-snapshot.js';

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const base: GraphSnapshot = {
  scopeId: '3d2e981e-0dcc-475a-97ec-47fe60850adc',
  intent: 'session:terminal',
  status: 'active',
  turns: 12,
  events: 47,
  pendingApprovals: 0,
  lastLesson: null,
};

describe('nextDensity', () => {
  it('cycles full → small → min → off → full', () => {
    const seq: Density[] = ['full', 'small', 'min', 'off'];
    let d: Density = 'full';
    for (let i = 1; i <= 4; i++) {
      d = nextDensity(d);
      expect(d).toBe(seq[i % 4]);
    }
  });
});

describe('buildWidgetLines', () => {
  it('off renders nothing', () => {
    expect(buildWidgetLines(theme, 80, base, 'off')).toEqual([]);
  });

  it('refuses to render in a too-narrow terminal', () => {
    expect(buildWidgetLines(theme, 6, base, 'full')).toEqual([]);
  });

  it('min is one line: brand + scope, nothing else', () => {
    const lines = buildWidgetLines(theme, 80, base, 'min');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('memex');
    expect(lines[0]).toContain('3d2e981e');
    expect(lines[0]).not.toContain('turns');
  });

  it('small is one dense line with brand, session and counts in plain language', () => {
    const lines = buildWidgetLines(theme, 80, base, 'small');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('memex');
    expect(lines[0]).toContain('session');
    expect(lines[0]).toContain('3d2e981e');
    expect(lines[0]).toContain('12');
    expect(lines[0]).toContain('in memory');
  });

  it('full (no lesson) is three lines: rule, session, labeled commands', () => {
    const lines = buildWidgetLines(theme, 80, base, 'full');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('memex'); // header rule
    expect(lines[1]).toContain('session'); // plain-language status
    expect(lines[1]).toContain('3d2e981e');
    expect(lines[1]).toContain('exchanges');
    expect(lines[2]).toContain('/density'); // command
    expect(lines[2]).toContain('history'); // its plain-word label
  });

  it('never repeats the model label (footer owns it)', () => {
    const text = buildWidgetLines(theme, 80, base, 'full').join('\n');
    expect(text).not.toContain('qwen');
    expect(text).not.toContain('gemini');
  });

  it('omits the lesson line entirely when there is none (no empty-state noise)', () => {
    const text = buildWidgetLines(theme, 80, base, 'full').join('\n');
    expect(text).not.toContain('no lessons');
  });

  it('adds a lesson line (4 lines) when a lesson exists', () => {
    const withLesson = {
      ...base,
      lastLesson: { content: 'Prefer resolveProfile over hardcoded baseUrl', confidence: 0.82 },
    };
    const lines = buildWidgetLines(theme, 80, withLesson, 'full');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toContain('resolveProfile');
    expect(lines[2]).toContain('0.82');
  });

  it('shows a pending-approvals chip only when there are pending approvals', () => {
    expect(buildWidgetLines(theme, 80, base, 'full')[1]).not.toContain('pending');
    const withPending = { ...base, pendingApprovals: 2 };
    expect(buildWidgetLines(theme, 80, withPending, 'full')[1]).toContain('2 pending');
  });

  it('keeps every line within the terminal width', () => {
    for (const d of ['min', 'small', 'full'] as Density[]) {
      const snap = { ...base, pendingApprovals: 3, lastLesson: { content: 'x'.repeat(200), confidence: 0.5 } };
      for (const line of buildWidgetLines(theme, 60, snap, d)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(60);
      }
    }
  });
});
