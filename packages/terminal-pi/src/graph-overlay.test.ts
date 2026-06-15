import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { buildGraphContent, buildMemoryContent } from './graph-overlay.js';
import type { GraphDetail, LessonRow } from './graph-snapshot.js';

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

const detail: GraphDetail = {
  scopeId: '3d2e981e-0dcc-475a-97ec-47fe60850adc',
  intent: 'session:terminal:1718',
  status: 'active',
  events: 47,
  breakdown: { conversation: 12, tool: 30, memory: 5, other: 0 },
  recent: [
    { kind: 'conversation', label: 'user', text: 'run the test suite', at: '2026-06-15T12:00:00Z' },
    { kind: 'tool', label: 'tool', text: 'execute_bash npm test', at: '2026-06-15T12:00:01Z' },
  ],
};

describe('buildGraphContent', () => {
  it('shows scope, status, trail breakdown and recent feed', () => {
    const out = buildGraphContent(theme, detail, 70).join('\n');
    expect(out).toContain('3d2e981e');
    expect(out).toContain('active');
    expect(out).toContain('47');
    expect(out).toContain('12 conversation · 30 tool · 5 memory');
    expect(out).toContain('run the test suite');
  });

  it('shows an empty recent state', () => {
    const out = buildGraphContent(theme, { ...detail, recent: [] }, 70).join('\n');
    expect(out).toContain('no events yet');
  });

  it('keeps recent lines within width', () => {
    const wide = { ...detail, recent: [{ kind: 'tool' as const, label: 'tool', text: 'x'.repeat(300), at: '' }] };
    for (const l of buildGraphContent(theme, wide, 50)) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
});

describe('buildMemoryContent', () => {
  const lessons: LessonRow[] = [
    { content: 'Prefer resolveProfile over hardcoded baseUrl when sharing provider config.', confidence: 0.92, reinforcementCount: 4 },
    { content: 'Short one', confidence: 0.5, reinforcementCount: 0 },
  ];

  it('lists lessons with confidence and reinforcement', () => {
    const out = buildMemoryContent(theme, lessons, 60).join('\n');
    expect(out).toContain('2 lessons');
    expect(out).toContain('0.92');
    expect(out).toContain('resolveProfile');
    expect(out).toContain('reinforced 4×');
  });

  it('omits reinforcement when zero', () => {
    const out = buildMemoryContent(theme, [lessons[1]], 60).join('\n');
    expect(out).not.toContain('reinforced');
  });

  it('shows an empty state', () => {
    expect(buildMemoryContent(theme, [], 60).join('\n')).toContain('no lessons yet');
  });

  it('wraps long lessons within width', () => {
    const long: LessonRow = { content: 'w '.repeat(120), confidence: 0.7, reinforcementCount: 1 };
    for (const l of buildMemoryContent(theme, [long], 50)) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
  });
});
