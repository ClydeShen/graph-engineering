import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { penalizeInjectedTemplates } from './template-injection.js';

function makePool(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>): Pool {
  return { query: vi.fn(queryImpl) } as unknown as Pool;
}

describe('penalizeInjectedTemplates (GH #24 failure_count path)', () => {
  it('increments failure_count for templates injected into the scope', async () => {
    const captured: { sql: string; params?: unknown[] }[] = [];
    const pool = makePool((sql, params) => {
      captured.push({ sql, params });
      return Promise.resolve({ rows: [], rowCount: 2 });
    });

    const result = await penalizeInjectedTemplates(pool, 'scope-99');

    expect(result.penalized).toBe(2);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.sql).toContain('failure_count = failure_count + 1');
    // Scoped to templates injected into THIS scope only.
    expect(captured[0]!.sql).toContain('SELECT template_id FROM template_injection WHERE scope_id = $1');
    expect(captured[0]!.params).toEqual(['scope-99']);
  });

  it('returns 0 when the scope had no injected templates', async () => {
    const pool = makePool(() => Promise.resolve({ rows: [], rowCount: 0 }));
    const result = await penalizeInjectedTemplates(pool, 'scope-empty');
    expect(result.penalized).toBe(0);
  });
});
