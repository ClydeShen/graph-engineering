/**
 * Memex graph widget — the persistent "graph is working memory" panel above the
 * editor (ADR-57 follow-up; the lazygit-style at-a-glance surface mapped from the
 * gsd-2 specimen, built purely on pi's ctx.ui.setWidget, no InteractiveMode fork).
 *
 * Four densities (progressive disclosure): full → small → min → off, cycled with
 * /density and persisted. The render is synchronous and reads a cached snapshot;
 * a 6s timer + agent_end refresh keep it live without ever awaiting in render.
 *
 * Copy-clean: built from render-kit (no vertical borders). color-not-only: every
 * status rides a glyph + number + word, never color alone.
 *
 * @see reference: gsd-2 auto-dashboard.ts updateProgressWidget
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { Pool } from 'pg';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { readGraphSnapshot, firstLine, type GraphSnapshot } from './graph-snapshot.js';
import { GLYPH, safeLine, statusGlyph, type ThemeLike } from './render-kit.js';

export type Density = 'full' | 'small' | 'min' | 'off';
const CYCLE: Density[] = ['full', 'small', 'min', 'off'];
const REFRESH_MS = 6000;

export function nextDensity(d: Density): Density {
  return CYCLE[(CYCLE.indexOf(d) + 1) % CYCLE.length]!;
}

function emptySnapshot(scopeId: string): GraphSnapshot {
  return { scopeId, intent: null, status: 'active', turns: 0, events: 0, pendingApprovals: 0, lastLesson: null };
}

/** Full-width rule carrying an inline brand title (ANSI-aware fill). */
function ruleWithTitle(theme: ThemeLike, width: number): string {
  const lead = theme.fg('borderAccent', '── ') + theme.bold(theme.fg('accent', `${GLYPH.brand} memex`)) + ' ';
  const fill = Math.max(0, width - visibleWidth(lead));
  return lead + theme.fg('borderMuted', '─'.repeat(fill));
}

/** Pending-approvals chip — warning glyph+count+word, only when > 0. */
function approvalsChip(theme: ThemeLike, n: number): string {
  return n > 0 ? theme.fg('warning', `${GLYPH.warn} ${n} pending`) : '';
}

/**
 * Pure: snapshot + density → widget lines. Exported for tests. Width-safe; never
 * throws. Single-responsibility chrome: shows graph STATE only — the model and
 * cwd live in pi's footer, so the widget never repeats them. Empty states (no
 * lesson) are omitted, not narrated.
 */
export function buildWidgetLines(
  theme: ThemeLike,
  width: number,
  snap: GraphSnapshot,
  density: Density,
): string[] {
  if (density === 'off' || width < 8) return [];

  const short = snap.scopeId.slice(0, 8);
  const dot = theme.fg('dim', GLYPH.dot);
  const brand = theme.bold(theme.fg('accent', `${GLYPH.brand} memex`));
  const scopeGlyph = statusGlyph(theme, snap.status === 'active' ? 'active' : 'idle');
  const statusWord = theme.fg(snap.status === 'active' ? 'success' : 'dim', snap.status);
  const counts = `${theme.fg('text', String(snap.turns))} ${theme.fg('dim', 'turns')} ${dot} ${theme.fg('text', String(snap.events))} ${theme.fg('dim', 'events')}`;
  const chip = approvalsChip(theme, snap.pendingApprovals);
  const clamp = (lines: string[]): string[] => lines.map((l) => safeLine(l, width, '…'));

  // MIN — brand + scope, nothing else.
  if (density === 'min') {
    return clamp([`${brand} ${dot} ${theme.fg('text', short)}`]);
  }

  // SMALL — one dense line: brand + scope + status + counts (+ chip).
  if (density === 'small') {
    const parts = [brand, `${scopeGlyph} ${theme.fg('text', short)} ${statusWord}`, counts];
    if (chip) parts.push(chip);
    return clamp([parts.join(` ${dot} `)]);
  }

  // FULL — header rule + status, the latest lesson (only if any), command hints.
  const lines = [ruleWithTitle(theme, width)];
  const statusParts = [`${scopeGlyph} ${theme.fg('text', short)} ${statusWord}`, counts];
  if (chip) statusParts.push(chip);
  lines.push(' ' + statusParts.join(` ${dot} `));
  if (snap.lastLesson) {
    const head = ` ${theme.fg('accent', GLYPH.action)} `;
    const tail = `  ${theme.fg('dim', `(${snap.lastLesson.confidence.toFixed(2)})`)}`;
    const room = Math.max(8, width - visibleWidth(head) - visibleWidth(tail) - 1);
    lines.push(head + theme.fg('text', firstLine(snap.lastLesson.content, room)) + tail);
  }
  lines.push(` ${theme.fg('dim', '/density')} ${dot} ${theme.fg('dim', '/graph')} ${dot} ${theme.fg('dim', '/memory')}`);
  return clamp(lines);
}

// ── Density persistence (survives restarts, mirrors gsd's preference store) ────

function densityFile(stateDir: string): string {
  return join(stateDir, 'widget.json');
}

export function readDensity(stateDir: string): Density {
  try {
    const raw = JSON.parse(readFileSync(densityFile(stateDir), 'utf8')) as { density?: string };
    if (raw.density && (CYCLE as string[]).includes(raw.density)) return raw.density as Density;
  } catch {
    /* default below */
  }
  return 'full';
}

function writeDensity(stateDir: string, density: Density): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(densityFile(stateDir), JSON.stringify({ density }));
  } catch {
    /* in-memory still updated */
  }
}

/**
 * Wire the widget: install on session_start (hasUI), refresh on a timer and at
 * each agent_end, and register /density to cycle. The whole thing is a no-op
 * without a UI (the -m / print path).
 */
export function makeGraphWidgetFactory(opts: {
  pool: Pool;
  scopeId: string;
  stateDir: string;
}): ExtensionFactory {
  const { pool, scopeId, stateDir } = opts;
  let density = readDensity(stateDir);
  let snapshot = emptySnapshot(scopeId);
  let tuiRef: { requestRender(): void } | null = null;
  let invalidateRef: (() => void) | null = null;

  const rerender = (): void => {
    invalidateRef?.();
    tuiRef?.requestRender();
  };
  const refresh = async (): Promise<void> => {
    if (density === 'off') return;
    snapshot = await readGraphSnapshot(pool, scopeId);
  };

  return (pi: ExtensionAPI) => {
    pi.registerCommand('density', {
      description: 'Cycle the memex graph widget density (full → small → min → off)',
      handler: async (_args, ctx) => {
        density = nextDensity(density);
        writeDensity(stateDir, density);
        if (density !== 'off') await refresh();
        rerender();
        ctx.ui.notify(`memex widget: ${density}`, 'info');
      },
    });

    pi.on('session_start', async (_event, ctx) => {
      if (!ctx.hasUI) return;
      await refresh();

      ctx.ui.setWidget(
        'memex-graph',
        (tui, theme) => {
          tuiRef = tui;
          let cachedLines: string[] | undefined;
          let cachedWidth: number | undefined;
          invalidateRef = () => {
            cachedLines = undefined;
            cachedWidth = undefined;
          };
          const timer = setInterval(() => {
            void refresh().then(rerender);
          }, REFRESH_MS);
          timer.unref?.();
          return {
            render(width: number): string[] {
              if (cachedLines && cachedWidth === width) return cachedLines;
              cachedLines = buildWidgetLines(theme as ThemeLike, width, snapshot, density);
              cachedWidth = width;
              return cachedLines;
            },
            invalidate(): void {
              cachedLines = undefined;
              cachedWidth = undefined;
            },
            dispose(): void {
              clearInterval(timer);
              tuiRef = null;
              invalidateRef = null;
            },
          };
        },
        { placement: 'aboveEditor' },
      );
    });

    // Bump the widget right after each turn so the turn/event counts feel live.
    pi.on('agent_end', async () => {
      await refresh();
      rerender();
    });
  };
}
