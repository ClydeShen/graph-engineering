/**
 * cron.test.ts — graph-native cron (ADR-45): matcher, tick semantics
 * (Phase 12 DoD G3), minute dedup, append-only config, delivery marker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const mockOccWrite = vi.fn().mockResolvedValue({ version_hash: 'v', occ_result: 'won' });
const mockWriteInfraEvent = vi.fn().mockResolvedValue(undefined);
const mockNestScope = vi.fn();

vi.mock('@graph/shared', () => ({
  occWrite: (...a: unknown[]) => mockOccWrite(...a),
  writeInfraEvent: (...a: unknown[]) => mockWriteInfraEvent(...a),
  canonicalJson: (v: unknown) => JSON.stringify(v),
}));
vi.mock('@graph/control-plane/nesting', () => ({
  nestScope: (...a: unknown[]) => mockNestScope(...a),
}));

import { cronMatches, runScopeIntent, CronService, CRON_REGISTRY_INTENT } from './cron.js';
import type { DeliveryRouter } from './delivery-router.js';

describe('cronMatches (5-field, minute precision)', () => {
  const monday0900 = new Date('2026-06-08T09:00:00'); // Monday
  it('matches exact minute/hour/dow', () => {
    expect(cronMatches('0 9 * * 1', monday0900)).toBe(true);
    expect(cronMatches('0 9 * * 2', monday0900)).toBe(false);
    expect(cronMatches('1 9 * * 1', monday0900)).toBe(false);
  });
  it('supports */n steps, ranges, and lists', () => {
    expect(cronMatches('*/15 * * * *', new Date('2026-06-08T09:30:00'))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date('2026-06-08T09:31:00'))).toBe(false);
    expect(cronMatches('0 8-10 * * *', monday0900)).toBe(true);
    expect(cronMatches('0 9 * 6,7 *', monday0900)).toBe(true);
  });
  it('rejects malformed expressions (not 5 fields)', () => {
    expect(cronMatches('0 9 * *', monday0900)).toBe(false);
  });
});

// ── CronService ──────────────────────────────────────────────────────────────

interface PoolScript {
  registryScope?: string;
  jobPayloads?: string[];
  runIntentExists?: boolean;
  closedRuns?: Array<{ scope_id: string; intent: string }>;
  runEvents?: string[];
}

function scriptedPool(s: PoolScript): Pool {
  const query = vi.fn((sql: string, params?: unknown[]) => {
    if (sql.includes('FROM scope_lineage WHERE intent = $1 LIMIT 1')) {
      const intent = params?.[0] as string;
      if (intent === CRON_REGISTRY_INTENT) {
        return Promise.resolve({ rows: s.registryScope ? [{ scope_id: s.registryScope }] : [] });
      }
      return Promise.resolve({ rows: s.runIntentExists ? [{ scope_id: 'existing-run' }] : [] });
    }
    if (sql.includes(`LIKE '%"kind":"cron_job"%'`)) {
      return Promise.resolve({ rows: (s.jobPayloads ?? []).map((p) => ({ payload: p })) });
    }
    if (sql.includes(`LIKE 'cron:%'`)) {
      return Promise.resolve({ rows: s.closedRuns ?? [] });
    }
    if (sql.includes('FROM execution_event_log')) {
      return Promise.resolve({ rows: (s.runEvents ?? []).map((p) => ({ payload: p })) });
    }
    return Promise.resolve({ rows: [] });
  });
  return { query } as unknown as Pool;
}

function makeRouter(): DeliveryRouter & { calls: unknown[] } {
  const r = {
    calls: [] as unknown[],
    async deliver(req: unknown) {
      r.calls.push(req);
      return { delivered: [], failed: [], suppressed: false };
    },
  };
  return r as unknown as DeliveryRouter & { calls: unknown[] };
}

const job = (over: Partial<Record<string, unknown>> = {}): string =>
  JSON.stringify({
    kind: 'cron_job', name: 'weekly', schedule: '0 9 * * 1',
    prompt: 'weekly summary', deliver: 'origin', origin: 'telegram:1', enabled: true,
    ...over,
  });

beforeEach(() => {
  vi.clearAllMocks();
  mockNestScope.mockResolvedValue({ scopeId: 'run-scope', planHash: 'p'.repeat(64) });
});

describe('CronService.tick', () => {
  const monday0900 = new Date('2026-06-08T09:00:00');

  it('fires a due job: fresh scope + task_spawned with prompt/deliver/origin', async () => {
    const pool = scriptedPool({ registryScope: 'reg', jobPayloads: [job()] });
    const svc = new CronService(pool, makeRouter());

    const fired = await svc.tick(monday0900);

    expect(fired).toEqual(['weekly']);
    expect(mockNestScope).toHaveBeenCalledWith(pool, runScopeIntent('weekly', monday0900));
    expect(mockOccWrite).toHaveBeenCalledWith(pool, expect.objectContaining({
      scopeId: 'run-scope',
      eventType: 'task_spawned',
      payload: expect.objectContaining({
        source: 'cron', text: 'weekly summary', cron_job: 'weekly',
        deliver: 'origin', origin: 'telegram:1',
      }),
    }));
  });

  it('skips when not due, disabled, or already fired this minute', async () => {
    const notDue = new Date('2026-06-08T10:00:00');
    expect(await new CronService(scriptedPool({ registryScope: 'r', jobPayloads: [job()] }), makeRouter()).tick(notDue)).toEqual([]);
    expect(await new CronService(scriptedPool({ registryScope: 'r', jobPayloads: [job({ enabled: false })] }), makeRouter()).tick(monday0900)).toEqual([]);
    expect(await new CronService(scriptedPool({ registryScope: 'r', jobPayloads: [job()], runIntentExists: true }), makeRouter()).tick(monday0900)).toEqual([]);
    expect(mockNestScope).not.toHaveBeenCalled();
  });

  it('latest Snapshot wins: a later disabled Snapshot overrides the earlier enabled one', async () => {
    const pool = scriptedPool({ registryScope: 'r', jobPayloads: [job(), job({ enabled: false })] });
    expect(await new CronService(pool, makeRouter()).tick(monday0900)).toEqual([]);
  });
});

describe('CronService.upsertCronJob', () => {
  it('appends an archived Snapshot to the registry scope (append-only history)', async () => {
    const pool = scriptedPool({ registryScope: 'reg' });
    await new CronService(pool, makeRouter()).upsertCronJob({
      name: 'daily', schedule: '0 8 * * *', prompt: 'p', deliver: 'all', enabled: true,
    });
    expect(mockWriteInfraEvent).toHaveBeenCalledWith(
      pool, 'reg', 'memory_updated',
      expect.stringContaining('"kind":"cron_job"'), 'archived',
    );
  });
});

describe('CronService.deliverClosedRuns', () => {
  it('delivers the completed output once and writes the delivered marker', async () => {
    const pool = scriptedPool({
      registryScope: 'reg',
      closedRuns: [{ scope_id: 'run-1', intent: 'cron:weekly:2026-06-08T09:00' }],
      runEvents: [
        JSON.stringify({ task_id: 't', deliver: 'origin', origin: 'telegram:1', text: 'weekly summary' }),
        JSON.stringify({ status: 'completed', output: 'report ready: 5 items' }),
      ],
    });
    const router = makeRouter();
    const n = await new CronService(pool, router).deliverClosedRuns();

    expect(n).toBe(1);
    expect(router.calls[0]).toMatchObject({
      deliver: 'origin', origin: 'telegram:1', text: 'report ready: 5 items', scope_id: 'run-1',
    });
    expect(mockWriteInfraEvent).toHaveBeenCalledWith(
      pool, 'run-1', 'memory_updated',
      expect.stringContaining('cron::delivered'), 'archived',
    );
  });

  it('runs with a delivered marker are excluded by the query (no double delivery)', async () => {
    const pool = scriptedPool({ registryScope: 'reg', closedRuns: [] });
    const router = makeRouter();
    expect(await new CronService(pool, router).deliverClosedRuns()).toBe(0);
    expect(router.calls).toHaveLength(0);
  });
});
