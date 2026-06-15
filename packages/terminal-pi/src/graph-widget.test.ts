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
    expect(buildWidgetLines(theme, 80, base, 'off', 'nvidia·qwen3')).toEqual([]);
  });

  it('refuses to render in a too-narrow terminal', () => {
    expect(buildWidgetLines(theme, 6, base, 'full', 'm')).toEqual([]);
  });

  it('min is a single line with brand, scope and counts', () => {
    const lines = buildWidgetLines(theme, 80, base, 'min', 'nvidia·qwen3');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('memex');
    expect(lines[0]).toContain('3d2e981e');
    expect(lines[0]).toContain('12');
    expect(lines[0]).toContain('47');
  });

  it('small is a title rule + one status line', () => {
    const lines = buildWidgetLines(theme, 80, base, 'small', 'nvidia·qwen3');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('memex');
    expect(lines[1]).toContain('scope');
  });

  it('full is six lines: rule, scope, counts, lesson, hints, rule', () => {
    const lines = buildWidgetLines(theme, 80, base, 'full', 'nvidia·qwen3');
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('memex'); // header rule
    expect(lines[1]).toContain('3d2e981e'); // scope line
    expect(lines[1]).toContain('nvidia·qwen3'); // model label
    expect(lines[2]).toContain('turns'); // counts
    expect(lines[4]).toContain('/density'); // hints
    expect(lines[5].replace(/─/g, '')).toBe(''); // closing rule
  });

  it('shows a pending-approvals chip only when there are pending approvals', () => {
    expect(buildWidgetLines(theme, 80, base, 'full', 'm')[2]).not.toContain('pending');
    const withPending = { ...base, pendingApprovals: 2 };
    expect(buildWidgetLines(theme, 80, withPending, 'full', 'm')[2]).toContain('2 pending');
  });

  it('shows an empty-state when there is no lesson, the lesson otherwise', () => {
    expect(buildWidgetLines(theme, 80, base, 'full', 'm')[3]).toContain('no lessons yet');
    const withLesson = {
      ...base,
      lastLesson: { content: 'Prefer resolveProfile over hardcoded baseUrl', confidence: 0.82 },
    };
    const line = buildWidgetLines(theme, 80, withLesson, 'full', 'm')[3];
    expect(line).toContain('0.82');
    expect(line).toContain('resolveProfile');
  });

  it('keeps every line within the terminal width', () => {
    for (const d of ['min', 'small', 'full'] as Density[]) {
      for (const line of buildWidgetLines(theme, 60, { ...base, pendingApprovals: 3 }, d, 'nvidia·qwen3')) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(60);
      }
    }
  });
});
