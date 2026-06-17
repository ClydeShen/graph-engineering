import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { penalizeInjectedTemplates } from './template-injection.js';

/**
 * Pool stub that answers the three queries penalizeInjectedTemplates issues, in
 * order: (1) injected templates join, (2) scope events, (3) the UPDATE. Returns
 * the captured UPDATE params so tests can assert which ids were softened.
 */
function makePool(injected: { id: string; content: string | null }[], events: { event_type: string; payload: string }[]) {
  let updateParams: unknown[] | undefined;
  const query = vi.fn((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM template_injection ti')) return Promise.resolve({ rows: injected, rowCount: injected.length });
    if (sql.includes('FROM execution_event_log')) return Promise.resolve({ rows: events, rowCount: events.length });
    if (sql.includes('failure_count = failure_count')) {
      updateParams = params;
      return Promise.resolve({ rows: [], rowCount: (params?.[0] as string[]).length });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return { pool: { query } as unknown as Pool, getUpdateParams: () => updateParams };
}

const task = (step: string) => ({ event_type: 'task_spawned', payload: JSON.stringify({ step }) });

const RULE = 'write_api before db_schema.'; // single ordering rule over the scope vocab

describe('penalizeInjectedTemplates (GH #30 conformance-gated soften)', () => {
  it('softens a template whose prescribed order was FOLLOWED yet the scope failed (ingredient implicated)', async () => {
    const { pool, getUpdateParams } = makePool(
      [{ id: 't-conform', content: RULE }],
      [task('write_api'), task('db_schema')], // order respects the rule
    );
    const result = await penalizeInjectedTemplates(pool, 'scope-1');
    expect(result.penalized).toBe(1);
    expect(getUpdateParams()).toEqual([['t-conform'], 1]); // failure_count += softenIncrement(1)
  });

  it('does NOT soften a template whose order was VIOLATED (cooking mistake, out of scope)', async () => {
    const { pool, getUpdateParams } = makePool(
      [{ id: 't-violate', content: RULE }],
      [task('db_schema'), task('write_api')], // reversed → violated
    );
    const result = await penalizeInjectedTemplates(pool, 'scope-2');
    expect(result.penalized).toBe(0);
    expect(getUpdateParams()).toBeUndefined();
  });

  it('fails closed when the lesson has no applicable rule for the scope (unjudgeable → untouched)', async () => {
    const { pool } = makePool(
      [{ id: 't-na', content: RULE }],
      [task('scaffold'), task('add_deps')], // neither rule token exercised
    );
    expect((await penalizeInjectedTemplates(pool, 'scope-3')).penalized).toBe(0);
  });

  it('softens only the conformant subset of a mixed injection set', async () => {
    const { pool, getUpdateParams } = makePool(
      [
        { id: 't-conform', content: 'write_api before db_schema.' },
        { id: 't-violate', content: 'db_schema before write_api.' },
        { id: 't-null', content: null },
      ],
      [task('write_api'), task('db_schema')],
    );
    const result = await penalizeInjectedTemplates(pool, 'scope-4');
    expect(result.penalized).toBe(1);
    expect(getUpdateParams()).toEqual([['t-conform'], 1]);
  });

  it('returns 0 when the scope had no injected templates', async () => {
    const { pool } = makePool([], []);
    expect((await penalizeInjectedTemplates(pool, 'scope-empty')).penalized).toBe(0);
  });
});
