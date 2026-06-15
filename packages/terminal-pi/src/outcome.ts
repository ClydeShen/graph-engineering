/**
 * Outcome panel — a status-colored surface for terminal moments the user must
 * not miss: a denied command, a blocker, a completed run. Mapped from gsd-2's
 * setAutoOutcomeWidget; copy-clean (renderPanel, no vertical borders), shown
 * below the editor and cleared at the next turn so it never lingers.
 *
 * color-not-only: status rides an icon + word + the rule color together.
 */

import { wrapVisibleText, renderPanel, GLYPH, type ThemeLike } from './render-kit.js';

export const OUTCOME_WIDGET_KEY = 'memex-outcome';

export type OutcomeStatus = 'complete' | 'blocked' | 'denied' | 'failed';

export interface OutcomeSnapshot {
  status: OutcomeStatus;
  title: string;
  /** One-line cause/explanation. */
  detail?: string;
  /** The thing it acted on (e.g. the command), shown verbatim. */
  subject?: string;
  /** What the user can do next. */
  next?: string;
}

function meta(status: OutcomeStatus): { icon: string; color: string } {
  switch (status) {
    case 'complete': return { icon: GLYPH.ok, color: 'success' };
    case 'blocked': return { icon: GLYPH.warn, color: 'warning' };
    case 'denied':
    case 'failed':
    default: return { icon: GLYPH.fail, color: 'error' };
  }
}

/** Pure: snapshot → panel lines. Exported for tests. */
export function buildOutcomeLines(theme: ThemeLike, width: number, snap: OutcomeSnapshot): string[] {
  const { icon, color } = meta(snap.status);
  const title = `${theme.fg(color, icon)} ${theme.bold(theme.fg(color, snap.title))}`;
  const inner: string[] = [];
  const wrapWidth = Math.max(8, width - 4);

  if (snap.detail) {
    for (const l of wrapVisibleText(theme.fg('text', snap.detail), wrapWidth)) inner.push(l);
  }
  if (snap.subject) {
    inner.push(`${theme.fg('dim', '$')} ${theme.fg('mdCode', snap.subject)}`);
  }
  if (snap.next) {
    if (inner.length > 0) inner.push('');
    inner.push(`${theme.fg('success', 'Next')}  ${theme.fg('text', snap.next)}`);
  }

  return renderPanel(theme, title, inner, width, { ruleColor: color });
}

/** ctx shape we need — structural so callers (approval, etc.) stay decoupled. */
interface OutcomeUI {
  hasUI: boolean;
  ui: { setWidget(key: string, content: ((tui: unknown, theme: ThemeLike) => unknown) | undefined, options?: unknown): void };
}

/** Show the outcome panel below the editor. No-op without a UI. */
export function setOutcomeWidget(ctx: OutcomeUI, snap: OutcomeSnapshot): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(
    OUTCOME_WIDGET_KEY,
    (_tui: unknown, theme: ThemeLike) => ({
      render(width: number): string[] {
        return buildOutcomeLines(theme, width, snap);
      },
      invalidate(): void {},
      dispose(): void {},
    }),
    { placement: 'belowEditor' },
  );
}

/** Remove the outcome panel (call at the start of the next turn). */
export function clearOutcome(ctx: OutcomeUI): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(OUTCOME_WIDGET_KEY, undefined);
}
