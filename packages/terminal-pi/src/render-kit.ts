/**
 * MemexTerminal TUI render-kit — width-safe, copy-clean terminal primitives.
 *
 * Mirrors the gsd-2 specimen's render-kit (a proven pattern over the same pi-tui
 * substrate we embed): pure functions built on pi-tui's ANSI- and CJK-aware
 * `truncateToWidth`/`visibleWidth`/`wrapTextWithAnsi`, so widths line up with the
 * rest of pi's chat. Two box idioms by intent (gsd discipline):
 *   - renderPanel  — no vertical `│` bars; copy-clean. Use for INLINE surfaces a
 *                    user may select+copy (the persistent widget, outcome panel).
 *   - renderFrame  — full box. Use for TRANSIENT overlays that benefit from
 *                    isolation (the /graph, /memory modals).
 *
 * Theme is taken structurally (ThemeLike) so these stay decoupled from pi's
 * concrete Theme and trivially unit-testable. Colors are SEMANTIC tokens from the
 * Observatory theme (accent/success/error/warning/dim/muted/text/border*).
 *
 * @see D:/Repo/specimens/gsd-2/src/resources/extensions/gsd/tui/render-kit.ts
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Consistent glyph family (no emoji — font-stable, themeable). color-not-only:
 *  always paired with a label/number so meaning never rides on color alone. */
export const GLYPH = {
  scope: '●',
  ok: '✓',
  fail: '✗',
  warn: '!',
  action: '▸',
  dot: '·',
  brand: '◆',
} as const;

/** Truncate to width, never throwing on width <= 0. */
export function safeLine(text: string, width: number, ellipsis = '…'): string {
  if (width <= 0) return '';
  return truncateToWidth(text, width, ellipsis);
}

/** Pad (visible) to exactly width with trailing spaces; truncates if longer. */
export function padRightVisible(text: string, width: number): string {
  if (width <= 0) return '';
  const truncated = safeLine(text, width);
  const pad = Math.max(0, width - visibleWidth(truncated));
  return truncated + ' '.repeat(pad);
}

/** Left text + right text on one line, gap-filled to width. */
export function rightAlign(left: string, right: string, width: number): string {
  if (width <= 0) return '';
  if (!right) return safeLine(left, width);
  if (!left) return safeLine(' '.repeat(Math.max(0, width - visibleWidth(right))) + right, width);
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
  return safeLine(left + ' '.repeat(gap) + right, width);
}

/** ANSI-aware word wrap; each line clamped to width. */
export function wrapVisibleText(text: string, width: number): string[] {
  if (width <= 0) return [text];
  return wrapTextWithAnsi(text, width).map((line) =>
    visibleWidth(line) > width ? truncateToWidth(line, width, '…') : line,
  );
}

/** Key-hint footer: "↑↓ scroll · esc close". */
export function renderKeyHints(theme: ThemeLike, hints: string[], width: number): string {
  return safeLine(theme.fg('dim', hints.filter(Boolean).join('  ·  ')), width);
}

/** A done/total progress bar (filled █ + empty ░), semantic-colored. */
export function renderProgressBar(
  theme: ThemeLike,
  done: number,
  total: number,
  width: number,
  options: { filledColor?: string; emptyColor?: string } = {},
): string {
  const barWidth = Math.max(0, width);
  const pct = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const filled = Math.round(pct * barWidth);
  return (
    theme.fg(options.filledColor ?? 'success', '█'.repeat(filled)) +
    theme.fg(options.emptyColor ?? 'dim', '░'.repeat(barWidth - filled))
  );
}

/** A status glyph in its semantic color. */
export function statusGlyph(
  theme: ThemeLike,
  level: 'active' | 'success' | 'warning' | 'error' | 'idle',
): string {
  switch (level) {
    case 'active': return theme.fg('accent', GLYPH.scope);
    case 'success': return theme.fg('success', GLYPH.ok);
    case 'warning': return theme.fg('warning', GLYPH.warn);
    case 'error': return theme.fg('error', GLYPH.fail);
    case 'idle':
    default: return theme.fg('dim', '○');
  }
}

/**
 * Titled panel WITHOUT vertical borders — only a header rule with an inline title
 * and a closing rule; body lines indented. No box char ever sits on a content
 * line, so terminal selection copies clean text. For inline, copyable surfaces.
 *
 *   ── Title ──────────────────────────────
 *
 *     body line
 *   ────────────────────────────────────────
 */
export function renderPanel(
  theme: ThemeLike,
  title: string,
  inner: string[],
  width: number,
  options: { ruleColor?: string; indent?: number } = {},
): string[] {
  if (width < 4) {
    return [safeLine(title, width), ...inner.map((line) => safeLine(line, width))];
  }
  const ruleColor = options.ruleColor ?? 'borderAccent';
  const indent = Math.max(0, options.indent ?? 2);
  const rule = (text: string) => theme.fg(ruleColor, text);

  const lead = '── ';
  const headerUsed = visibleWidth(lead) + visibleWidth(title) + 1;
  const headerFill = Math.max(0, width - headerUsed);
  const header = safeLine(rule(lead) + title + ' ' + rule('─'.repeat(headerFill)), width, '');

  const pad = ' '.repeat(indent);
  const contentWidth = Math.max(0, width - indent);
  const body = inner.map((line) => safeLine(pad + safeLine(line, contentWidth), width, ''));

  return [header, '', ...body, rule('─'.repeat(width))];
}

/**
 * Full box frame (╭─╮ │ ╰─╯) — isolates transient overlay content. Use for modals
 * (/graph, /memory), never for copyable inline output.
 */
export function renderFrame(
  theme: ThemeLike,
  inner: string[],
  width: number,
  options: { borderColor?: string; paddingX?: number } = {},
): string[] {
  if (width < 4) return inner.map((line) => safeLine(line, width));
  const borderColor = options.borderColor ?? 'borderAccent';
  const paddingX = Math.max(0, options.paddingX ?? 1);
  const contentWidth = Math.max(0, width - 2 - paddingX * 2);
  const border = (text: string) => theme.fg(borderColor, text);
  const pad = ' '.repeat(paddingX);

  const lines = [border('╭' + '─'.repeat(width - 2) + '╮')];
  for (const line of inner) {
    lines.push(border('│') + pad + padRightVisible(line, contentWidth) + pad + border('│'));
  }
  lines.push(border('╰' + '─'.repeat(width - 2) + '╯'));
  return lines.map((line) => safeLine(line, width, ''));
}
