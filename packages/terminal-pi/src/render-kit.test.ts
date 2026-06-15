import { describe, it, expect } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  safeLine,
  padRightVisible,
  rightAlign,
  wrapVisibleText,
  renderProgressBar,
  renderPanel,
  renderFrame,
  statusGlyph,
  GLYPH,
} from './render-kit.js';

/** Identity theme: fg/bold return text unchanged so visibleWidth = plain width. */
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

describe('render-kit width safety', () => {
  it('safeLine truncates to width with ellipsis and never exceeds it', () => {
    expect(visibleWidth(safeLine('hello world', 5))).toBeLessThanOrEqual(5);
    expect(safeLine('hi', 0)).toBe('');
  });

  it('padRightVisible pads to exactly width', () => {
    expect(padRightVisible('ab', 5)).toBe('ab   ');
    expect(visibleWidth(padRightVisible('abcdef', 4))).toBe(4);
  });

  it('rightAlign places right text flush-right within width', () => {
    const line = rightAlign('left', 'R', 10);
    expect(visibleWidth(line)).toBe(10);
    expect(line.endsWith('R')).toBe(true);
    expect(line.startsWith('left')).toBe(true);
  });

  it('wrapVisibleText wraps long text and clamps each line', () => {
    const lines = wrapVisibleText('the quick brown fox jumps', 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(10);
  });
});

describe('renderProgressBar', () => {
  it('fills proportionally to done/total', () => {
    const bar = renderProgressBar(theme, 5, 10, 10);
    expect(bar).toBe('█████░░░░░');
  });
  it('is empty at 0 and full at total', () => {
    expect(renderProgressBar(theme, 0, 10, 4)).toBe('░░░░');
    expect(renderProgressBar(theme, 10, 10, 4)).toBe('████');
  });
  it('treats total 0 as empty (no divide-by-zero)', () => {
    expect(renderProgressBar(theme, 0, 0, 4)).toBe('░░░░');
  });
});

describe('renderPanel (copy-clean)', () => {
  const out = renderPanel(theme, 'Title', ['body one', 'body two'], 40);

  it('opens with a rule that carries the title inline', () => {
    expect(out[0]).toContain('Title');
    expect(out[0]).toContain('──');
  });

  it('puts NO vertical bar on any content line (copy-clean)', () => {
    for (const line of out) expect(line).not.toContain('│');
  });

  it('indents body and closes with a rule', () => {
    expect(out.some((l) => l.includes('  body one'))).toBe(true);
    expect(out[out.length - 1].replace(/─/g, '')).toBe('');
  });
});

describe('renderFrame (transient overlay)', () => {
  const out = renderFrame(theme, ['x'], 20);
  it('draws a full box with corners and side bars', () => {
    expect(out[0]).toContain('╭');
    expect(out[0]).toContain('╮');
    expect(out[1]).toContain('│');
    expect(out[out.length - 1]).toContain('╰');
    expect(out.every((l) => visibleWidth(l) <= 20)).toBe(true);
  });
});

describe('statusGlyph', () => {
  it('maps levels to the consistent glyph family', () => {
    expect(statusGlyph(theme, 'active')).toBe(GLYPH.scope);
    expect(statusGlyph(theme, 'success')).toBe(GLYPH.ok);
    expect(statusGlyph(theme, 'error')).toBe(GLYPH.fail);
    expect(statusGlyph(theme, 'warning')).toBe(GLYPH.warn);
  });
});
