/**
 * Read-only graph/memory overlays — the "lazygit-style" browsable surfaces for
 * /graph (this scope's trail) and /memory (crystallized lessons). Transient
 * modals, so they use the full-box renderFrame (isolation), unlike the inline
 * copy-clean widget/outcome. Keyboard contract mirrors gsd-2's
 * GSDNotificationOverlay: esc/ctrl-c close, ↑↓/jk scroll, g/G jump.
 *
 * Read-only by design (the prior MemexTerminal "observable ≠ operable → read-only
 * first" decision). Content is a one-shot snapshot built at open.
 *
 * @see D:/Repo/specimens/gsd-2/src/resources/extensions/gsd/notification-overlay.ts
 */

import { Key, matchesKey } from '@earendil-works/pi-tui';
import type { Pool } from 'pg';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  readGraphDetail,
  readLessons,
  relativeAge,
  type GraphDetail,
  type LessonRow,
} from './graph-snapshot.js';
import {
  GLYPH,
  renderFrame,
  renderKeyHints,
  safeLine,
  wrapVisibleText,
  type ThemeLike,
} from './render-kit.js';

const OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: { width: '80%', minWidth: 60, maxHeight: '80%', anchor: 'center', backdrop: true },
} as const;

function kindGlyph(theme: ThemeLike, kind: string): string {
  switch (kind) {
    case 'conversation': return theme.fg('accent', GLYPH.scope);
    case 'tool': return theme.fg('success', GLYPH.action);
    case 'memory': return theme.fg('mdLink', '✦');
    default: return theme.fg('dim', GLYPH.dot);
  }
}

/** Pure: scope detail → overlay body lines wrapped to width. Exported for tests. */
export function buildGraphContent(theme: ThemeLike, detail: GraphDetail, width: number): string[] {
  const lines: string[] = [];
  const b = detail.breakdown;
  lines.push(`${theme.fg('dim', 'scope ')}${theme.fg('text', detail.scopeId.slice(0, 8))}`);
  for (const l of wrapVisibleText(`${theme.fg('dim', 'intent ')}${theme.fg('text', detail.intent ?? '—')}`, width)) {
    lines.push(l);
  }
  lines.push(`${theme.fg('dim', 'status ')}${theme.fg(detail.status === 'active' ? 'success' : 'dim', detail.status)}`);
  lines.push('');
  lines.push(`${theme.fg('accent', 'trail')}  ${theme.fg('text', String(detail.events))} ${theme.fg('dim', 'events')}`);
  lines.push(
    `  ${theme.fg('dim', `${b.conversation} conversation · ${b.tool} tool · ${b.memory} memory · ${b.other} other`)}`,
  );
  lines.push('');
  lines.push(theme.fg('accent', 'recent'));
  if (detail.recent.length === 0) {
    lines.push(`  ${theme.fg('dim', 'no events yet')}`);
  } else {
    for (const ev of detail.recent) {
      const head = `  ${kindGlyph(theme, ev.kind)} ${theme.fg('dim', ev.label.padEnd(9))} `;
      const text = theme.fg('text', ev.text || theme.fg('dim', '—'));
      const age = ev.at ? theme.fg('dim', ` ${relativeAge(ev.at)}`) : '';
      lines.push(safeLine(head + text + age, width, '…'));
    }
  }
  return lines;
}

/** Pure: lessons → overlay body lines wrapped to width. Exported for tests. */
export function buildMemoryContent(theme: ThemeLike, lessons: LessonRow[], width: number): string[] {
  if (lessons.length === 0) {
    return [theme.fg('dim', 'no lessons yet · they crystallize as scopes close')];
  }
  const lines: string[] = [theme.fg('dim', `${lessons.length} lessons · sorted by confidence`), ''];
  for (const l of lessons) {
    const head = `${theme.fg('success', GLYPH.ok)} ${theme.fg('success', l.confidence.toFixed(2))}  `;
    const wrapped = wrapVisibleText(theme.fg('text', l.content), Math.max(8, width - 8));
    wrapped.forEach((w, i) => lines.push(i === 0 ? head + w : '        ' + w));
    if (l.reinforcementCount > 0) {
      lines.push(`        ${theme.fg('dim', `reinforced ${l.reinforcementCount}×`)}`);
    }
    lines.push('');
  }
  return lines;
}

/**
 * Scrollable read-only overlay. Generic over its body builder so /graph and
 * /memory share one implementation. Structural tui type keeps it decoupled.
 */
export class MemexOverlay {
  private readonly tui: { requestRender(): void };
  private readonly theme: ThemeLike;
  private readonly onClose: () => void;
  private readonly title: string;
  private readonly buildBody: (theme: ThemeLike, width: number) => string[];
  private scroll = 0;
  private cachedWidth?: number;
  private cachedBody?: string[];
  private disposed = false;
  private readonly resizeHandler: () => void;

  constructor(
    tui: { requestRender(): void },
    theme: ThemeLike,
    title: string,
    buildBody: (theme: ThemeLike, width: number) => string[],
    onClose: () => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.title = title;
    this.buildBody = buildBody;
    this.onClose = onClose;
    this.resizeHandler = () => {
      if (this.disposed) return;
      this.invalidate();
      this.tui.requestRender();
    };
    process.stdout.on('resize', this.resizeHandler);
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl('c')) || data === 'q') {
      this.dispose();
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.down) || data === 'j') {
      this.scroll++;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.up) || data === 'k') {
      this.scroll = Math.max(0, this.scroll - 1);
      this.tui.requestRender();
      return;
    }
    if (data === 'g') {
      this.scroll = 0;
      this.tui.requestRender();
      return;
    }
    if (data === 'G') {
      this.scroll = Number.MAX_SAFE_INTEGER;
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(8, width - 4);
    if (!this.cachedBody || this.cachedWidth !== width) {
      this.cachedBody = this.buildBody(this.theme, innerWidth);
      this.cachedWidth = width;
    }
    const body = this.cachedBody;

    const terminalRows = process.stdout.rows || 32;
    const chrome = 6; // frame borders + title + blank + hint
    const maxBodyRows = Math.max(3, Math.min(body.length, Math.floor(terminalRows * 0.8) - chrome));
    const maxScroll = Math.max(0, body.length - maxBodyRows);
    this.scroll = Math.min(this.scroll, maxScroll);
    const visible = body.slice(this.scroll, this.scroll + maxBodyRows);

    const titleLine = `${this.theme.fg('accent', `${GLYPH.brand} ${this.title}`)}`;
    const position = body.length > maxBodyRows
      ? `  ${this.theme.fg('dim', `[${this.scroll + 1}–${this.scroll + visible.length}/${body.length}]`)}`
      : '';
    const hint = renderKeyHints(this.theme, ['↑↓/jk scroll', 'g/G top/bottom', 'esc close'], innerWidth) + position;

    return renderFrame(this.theme, [titleLine, '', ...visible, '', hint], width);
  }

  invalidate(): void {
    this.cachedBody = undefined;
    this.cachedWidth = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    process.stdout.removeListener('resize', this.resizeHandler);
  }
}

/** Register /graph and /memory read-only overlays. */
export function registerGraphCommands(pi: ExtensionAPI, pool: Pool, scopeId: string): void {
  pi.registerCommand('graph', {
    description: "Browse this scope's trail (read-only)",
    handler: async (_args, ctx) => {
      const detail = await readGraphDetail(pool, scopeId);
      if (!ctx.hasUI) {
        ctx.ui.notify(`scope ${scopeId.slice(0, 8)} · ${detail.events} events`, 'info');
        return;
      }
      await ctx.ui.custom<boolean>(
        (tui, theme, _kb, done) =>
          new MemexOverlay(
            tui as { requestRender(): void },
            theme as unknown as ThemeLike,
            `graph · scope ${scopeId.slice(0, 8)}`,
            (th, w) => buildGraphContent(th, detail, w),
            () => done(true),
          ),
        OVERLAY_OPTIONS,
      );
    },
  });

  pi.registerCommand('memory', {
    description: 'Browse crystallized lessons (read-only)',
    handler: async (_args, ctx) => {
      const lessons = await readLessons(pool, 100);
      if (!ctx.hasUI) {
        ctx.ui.notify(`${lessons.length} lessons`, 'info');
        return;
      }
      await ctx.ui.custom<boolean>(
        (tui, theme, _kb, done) =>
          new MemexOverlay(
            tui as { requestRender(): void },
            theme as unknown as ThemeLike,
            'memory · lessons',
            (th, w) => buildMemoryContent(th, lessons, w),
            () => done(true),
          ),
        OVERLAY_OPTIONS,
      );
    },
  });
}
