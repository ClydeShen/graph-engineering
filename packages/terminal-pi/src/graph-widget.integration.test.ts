/**
 * Integration: drives makeGraphWidgetFactory through the pi extension lifecycle
 * with a simulated hasUI ctx (the interactive path the -m smoke test can't reach
 * without a TTY). Proves session_start installs the widget, the component renders
 * real snapshot data, /density cycles it, and dispose is clean.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { makeGraphWidgetFactory } from './graph-widget.js';

// Stub pool routed by SQL fragment — returns populated rows so render has data.
const pool = {
  query: async (sql: string) => {
    if (sql.includes('procedural_memory')) return { rows: [{ content: 'Use seams', confidence: 0.9 }] };
    if (sql.includes('approval_request')) return { rows: [{ n: '1' }] };
    if (sql.includes('FILTER')) return { rows: [{ turns: '3', events: '9' }] };
    return { rows: [{ intent: 'session:test', status: 'active' }] };
  },
} as unknown as Pool;

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function harness() {
  const handlers: Record<string, (e: unknown, ctx: unknown) => Promise<unknown>> = {};
  const commands: Record<string, { handler: (a: string, ctx: unknown) => Promise<void> }> = {};
  const pi = {
    on: (ev: string, h: (e: unknown, ctx: unknown) => Promise<unknown>) => { handlers[ev] = h; },
    registerCommand: (n: string, o: { handler: (a: string, ctx: unknown) => Promise<void> }) => { commands[n] = o; },
    registerShortcut: () => {},
  } as unknown as ExtensionAPI;
  let widgetFactory: ((tui: unknown, theme: unknown) => { render(w: number): string[]; dispose(): void }) | undefined;
  let widgetOpts: unknown;
  const ctx = {
    hasUI: true,
    ui: {
      setWidget: (_k: string, f: typeof widgetFactory, o: unknown) => { widgetFactory = f; widgetOpts = o; },
      notify: () => {},
    },
  };
  return { handlers, commands, pi, ctx, get widgetFactory() { return widgetFactory; }, get widgetOpts() { return widgetOpts; } };
}

describe('graph widget lifecycle (simulated hasUI)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'memex-widget-'));
  const scopeId = 'abcd1234-0000-0000-0000-000000000000';

  it('installs an aboveEditor widget on session_start and renders snapshot data', async () => {
    const h = harness();
    makeGraphWidgetFactory({ pool, scopeId, modelLabel: 'nvidia·qwen3', stateDir })(h.pi);

    await h.handlers['session_start']({}, h.ctx);
    expect(h.widgetFactory).toBeDefined();
    expect(h.widgetOpts).toEqual({ placement: 'aboveEditor' });

    const comp = h.widgetFactory!({ requestRender: () => {} }, theme);
    const lines = comp.render(80);
    const text = lines.join('\n');
    expect(text).toContain('memex');
    expect(text).toContain('abcd1234');
    expect(text).toContain('3'); // turns
    expect(text).toContain('1 pending'); // approvals chip
    expect(text).toContain('Use seams'); // lesson
    expect(() => comp.dispose()).not.toThrow();
  });

  it('/density cycles the widget from full (6 lines) to small (2 lines)', async () => {
    const h = harness();
    makeGraphWidgetFactory({ pool, scopeId, modelLabel: 'm', stateDir })(h.pi);
    await h.handlers['session_start']({}, h.ctx);
    const comp = h.widgetFactory!({ requestRender: () => {} }, theme);

    expect(comp.render(80)).toHaveLength(6); // full
    await h.commands['density'].handler('', h.ctx);
    expect(comp.render(80)).toHaveLength(2); // small
    comp.dispose();
  });

  it('is a no-op without a UI (the -m / print path)', async () => {
    const h = harness();
    makeGraphWidgetFactory({ pool, scopeId, modelLabel: 'm', stateDir })(h.pi);
    await h.handlers['session_start']({}, { hasUI: false, ui: h.ctx.ui });
    expect(h.widgetFactory).toBeUndefined();
  });
});
