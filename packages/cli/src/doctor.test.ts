import { describe, it, expect, vi } from 'vitest';
import { runDoctor, formatDoctorReport, type DoctorProbes, type DoctorResult } from './doctor.js';
import type { MemexConfig } from '@graph/shared';

function probes(overrides: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    loadConfig: () => null,
    query: null,
    fetchFn: vi.fn().mockRejectedValue(new Error('no network')) as unknown as typeof fetch,
    nodeVersion: 'v22.22.3',
    env: {},
    ...overrides,
  };
}

function byName(results: DoctorResult[], name: string): DoctorResult {
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`missing check ${name}`);
  return r;
}

/**
 * SQL-shape-aware query mock for the hash-chain check. Routes on substrings of
 * the doctor's three queries; everything else returns empty.
 */
function chainQuery(opts: { badContent?: number; broken?: number; scopes?: string[] }) {
  return vi.fn().mockImplementation((sql: string) => {
    if (sql.includes('DISTINCT scope_id')) {
      return Promise.resolve({ rows: (opts.scopes ?? ['s1']).map((s) => ({ scope_id: s })) });
    }
    if (sql.includes('erased_at IS NULL')) {
      return Promise.resolve({ rows: [{ bad: opts.badContent ?? 0 }] });
    }
    if (sql.includes('NOT EXISTS')) {
      return Promise.resolve({ rows: [{ broken: opts.broken ?? 0 }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('memex doctor (Phase 15 G4)', () => {
  it('reports warn for missing config and fail for missing DB; remaining checks still run', async () => {
    const results = await runDoctor(probes());
    expect(byName(results, 'config').status).toBe('warn');
    expect(byName(results, 'postgres').status).toBe('fail');
    expect(byName(results, 'migrations').status).toBe('skip');
    expect(byName(results, 'hash-chain').status).toBe('skip');
    expect(byName(results, 'node-version').status).toBe('ok');
    expect(results).toHaveLength(8); // a failure never aborts the run
  });

  it('fails node-version below 22', async () => {
    const results = await runDoctor(probes({ nodeVersion: 'v20.11.0' }));
    expect(byName(results, 'node-version').status).toBe('fail');
  });

  it('postgres ok requires both pgvector and pgcrypto', async () => {
    const both = vi.fn().mockResolvedValue({ rows: [{ extname: 'vector' }, { extname: 'pgcrypto' }] });
    const one = vi.fn().mockResolvedValue({ rows: [{ extname: 'pgcrypto' }] });

    const okRun = await runDoctor(probes({ query: (sql, p) => both(sql, p) }));
    expect(byName(okRun, 'postgres').status).toBe('ok');

    const failRun = await runDoctor(probes({ query: (sql, p) => one(sql, p) }));
    const pg = byName(failRun, 'postgres');
    expect(pg.status).toBe('fail');
    expect(pg.detail).toContain('vector');
  });

  it('migrations watermark: erased_at present = ok, absent = warn', async () => {
    const withCol = vi.fn().mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('information_schema') ? { rows: [{ '?column?': 1 }] } : { rows: [] },
      ),
    );
    const results = await runDoctor(probes({ query: (s, p) => withCol(s, p) }));
    expect(byName(results, 'migrations').status).toBe('ok');

    const noCol = vi.fn().mockResolvedValue({ rows: [] });
    const results2 = await runDoctor(probes({ query: (s, p) => noCol(s, p) }));
    expect(byName(results2, 'migrations').status).toBe('warn');
  });

  describe('hash-chain check (ADR-43 D-3 erased_at rule)', () => {
    it('passes when sampled scopes have intact content and linkage', async () => {
      const q = chainQuery({});
      const results = await runDoctor(probes({ query: (s, p) => q(s, p) }));
      expect(byName(results, 'hash-chain').status).toBe('ok');
    });

    it('content re-verification EXCLUDES erased rows (query carries erased_at IS NULL)', async () => {
      const q = chainQuery({});
      await runDoctor(probes({ query: (s, p) => q(s, p) }));
      const contentSql = q.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .find((s: string) => s.includes('digest('));
      // The recompute query must skip blanked payloads — and only that query.
      expect(contentSql).toContain('erased_at IS NULL');
    });

    it('linkage verification INCLUDES erased rows (no erased_at filter on the link query)', async () => {
      const q = chainQuery({});
      await runDoctor(probes({ query: (s, p) => q(s, p) }));
      const linkSql = q.mock.calls
        .map((c: unknown[]) => String(c[0]))
        .find((s: string) => s.includes('NOT EXISTS'));
      expect(linkSql).toBeDefined();
      expect(linkSql).not.toContain('erased_at');
    });

    it('fails on content hash mismatch and on dangling predecessor links', async () => {
      const badContent = chainQuery({ badContent: 2 });
      const r1 = await runDoctor(probes({ query: (s, p) => badContent(s, p) }));
      expect(byName(r1, 'hash-chain').status).toBe('fail');
      expect(byName(r1, 'hash-chain').detail).toContain('hash mismatch');

      const dangling = chainQuery({ broken: 1 });
      const r2 = await runDoctor(probes({ query: (s, p) => dangling(s, p) }));
      expect(byName(r2, 'hash-chain').status).toBe('fail');
      expect(byName(r2, 'hash-chain').detail).toContain('dangling');
    });

    it('empty ledger is ok, not a failure', async () => {
      const q = chainQuery({ scopes: [] });
      const results = await runDoctor(probes({ query: (s, p) => q(s, p) }));
      expect(byName(results, 'hash-chain').status).toBe('ok');
    });
  });

  it('providers: reachable baseUrl ok; missing key downgrades to warn', async () => {
    const config: MemexConfig = {
      providers: [
        { name: 'local', type: 'openai', baseUrl: 'http://localhost:11434', model: 'm', priority: 1 },
        { name: 'cloud', type: 'anthropic', model: 'm', priority: 2 },
      ],
    };
    const fetchOk = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const results = await runDoctor(
      probes({ loadConfig: () => config, fetchFn: fetchOk as unknown as typeof fetch }),
    );
    const prov = byName(results, 'llm-providers');
    expect(prov.status).toBe('warn'); // cloud has no apiKey
    expect(prov.detail).toContain('local: reachable');
    expect(prov.detail).toContain('cloud: NO KEY');
  });

  it('gateway: alive when /v1/sys/health responds ok; warn when down', async () => {
    const fetchOk = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const up = await runDoctor(probes({ fetchFn: fetchOk as unknown as typeof fetch }));
    expect(byName(up, 'gateway').status).toBe('ok');
    expect(fetchOk).toHaveBeenCalledWith(expect.stringContaining('/v1/sys/health'), expect.anything());

    const down = await runDoctor(probes());
    expect(byName(down, 'gateway').status).toBe('warn');
  });

  it('channels: token presence only — doctor never calls channel APIs', async () => {
    const config: MemexConfig = {
      channels: { telegram: { token: 't' }, discord: {} },
    };
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const results = await runDoctor(
      probes({ loadConfig: () => config, fetchFn: fetchSpy as unknown as typeof fetch }),
    );
    const ch = byName(results, 'channels');
    expect(ch.status).toBe('warn');
    expect(ch.detail).toContain('discord');
    // fetch was used by gateway/provider checks only — never with a channel API host
    for (const call of fetchSpy.mock.calls) {
      expect(String(call[0])).not.toMatch(/telegram|discord/);
    }
  });

  it('formatDoctorReport counts failures and warnings', () => {
    const report = formatDoctorReport([
      { name: 'a', status: 'ok', detail: 'fine' },
      { name: 'b', status: 'fail', detail: 'broken' },
      { name: 'c', status: 'warn', detail: 'meh' },
    ]);
    expect(report).toContain('1 failure(s), 1 warning(s)');
    expect(report).toContain('✗ b');
  });
});
