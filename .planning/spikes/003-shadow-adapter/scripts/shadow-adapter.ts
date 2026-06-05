/**
 * Spike 003: InMemoryShadowAdapter
 *
 * Validates the core Pi Sandbox mechanism:
 * 1. pool.query() writes (OCC CTE pattern) → captured in Map, never reach PostgreSQL
 * 2. pool.query() reads (SELECT) → pass through to real pool
 * 3. clear() destroys all captured entries (阅后即焚)
 *
 * Run: npx tsx .planning/spikes/003-shadow-adapter/scripts/shadow-adapter.ts
 */

// ---------------------------------------------------------------------------
// Types (mirrors pg.Pool surface we actually use)
// ---------------------------------------------------------------------------

interface QueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
}

interface PoolLike {
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
}

// ---------------------------------------------------------------------------
// Shadow entry shape — what we capture instead of writing to PostgreSQL
// ---------------------------------------------------------------------------

export interface ShadowEntry {
  table: string;
  scopeId: string;
  entityId: string;
  predecessorHash: string;
  canonicalText: string;
  eventType: string;
  capturedAt: Date;
}

// ---------------------------------------------------------------------------
// InMemoryShadowAdapter
//
// Wraps a Pool-compatible object. All OCC write calls (SQL starting with
// "WITH new_version AS") are swallowed into entries[]. All reads pass through.
//
// Usage:
//   const shadow = new InMemoryShadowAdapter(realPool);
//   await occWrite(shadow.proxy, args);  // ← uses shadow.proxy, not realPool
//   const entries = shadow.getEntries();
//   shadow.clear();                      // 阅后即焚
// ---------------------------------------------------------------------------

export class InMemoryShadowAdapter {
  private readonly real: PoolLike;
  private entries: ShadowEntry[] = [];

  constructor(real: PoolLike) {
    this.real = real;
  }

  // Proxy that looks like a Pool but intercepts writes.
  get proxy(): PoolLike {
    const self = this;
    return {
      query(sql: string, params?: unknown[]) {
        return self.routeQuery(sql, params);
      },
    };
  }

  private async routeQuery(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult> {
    // OCC Writable CTE pattern — both OCC_WRITE_SQL and OCC_WRITE_DO_NOTHING_SQL
    // open with this prefix (see packages/shared/src/sql/occ-writable-cte.sql.ts)
    if (sql.trimStart().startsWith('WITH new_version AS')) {
      return this.captureWrite(sql, params as string[]);
    }
    // Reads and other queries → real pool
    return this.real.query(sql, params);
  }

  private captureWrite(sql: string, params: string[]): QueryResult {
    // params order per occ-writable-cte.sql.ts:
    //   $1 scopeId, $2 entityId, $3 predecessorHash, $4 canonicalText, $5 eventType
    const [scopeId, entityId, predecessorHash, canonicalText, eventType] =
      params;

    const tableMatch = sql.match(/INSERT INTO\s+(\S+)/i);
    const table = tableMatch?.[1] ?? 'execution_event_log_shadow';

    this.entries.push({
      table,
      scopeId,
      entityId,
      predecessorHash,
      canonicalText,
      eventType: eventType ?? 'memory_updated',
      capturedAt: new Date(),
    });

    // Fake a 'won' WriteResult — the shadow session always "wins" (no OCC contention)
    const fakeHash = `shadow::${scopeId}::${entityId}::${Date.now()}`;
    return {
      rows: [
        {
          version_hash: fakeHash,
          event_type: eventType ?? 'memory_updated',
          occ_result: 'won',
        },
      ],
      rowCount: 1,
    };
  }

  getEntries(): readonly ShadowEntry[] {
    return this.entries;
  }

  /** 阅后即焚 — destroy all captured shadow entries. */
  clear(): void {
    this.entries = [];
  }
}

// ---------------------------------------------------------------------------
// Self-contained verification (no external deps, no real PostgreSQL)
// ---------------------------------------------------------------------------

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  PASS: ${msg}`);
}

async function run() {
  console.log('\n=== Spike 003: InMemoryShadowAdapter ===\n');

  // --- Mock "real" pool that records every query call ---
  const realCalls: { sql: string; params: unknown[] }[] = [];
  const mockPool: PoolLike = {
    async query(sql, params = []) {
      realCalls.push({ sql, params });
      // Simulate SELECT result
      return { rows: [{ id: 1, entity_id: 'e-real' }], rowCount: 1 };
    },
  };

  const shadow = new InMemoryShadowAdapter(mockPool);
  const proxy = shadow.proxy;

  // --- Test 1: OCC write is intercepted, real pool never called ---
  console.log('Test 1: OCC write → shadow (no real pool call)');
  const occSql = `WITH new_version AS (
    INSERT INTO execution_event_log_202506
    (scope_id, entity_id, predecessor_hash, payload, event_type)
    VALUES ($1::uuid, $2::uuid, $3, $4::text, $5)
    ON CONFLICT (predecessor_hash, scope_id) DO UPDATE SET ...
  )
  SELECT version_hash, event_type, occ_result FROM new_version`;

  const writeResult = await proxy.query(occSql, [
    'scope-uuid-1',
    'entity-uuid-1',
    'ZERO_HASH',
    '{"task":"refactor auth"}',
    'task_spawned',
  ]);

  assert(realCalls.length === 0, 'real pool was NOT called for OCC write');
  assert(shadow.getEntries().length === 1, '1 entry captured in shadow');
  assert(
    shadow.getEntries()[0].scopeId === 'scope-uuid-1',
    'scopeId captured correctly',
  );
  assert(
    (writeResult.rows[0] as { occ_result: string }).occ_result === 'won',
    'fake WriteResult returns occ_result=won',
  );

  // --- Test 2: SELECT passes through to real pool ---
  console.log('\nTest 2: SELECT → real pool passthrough');
  const selectResult = await proxy.query(
    'SELECT * FROM execution_event_log WHERE scope_id = $1',
    ['scope-uuid-1'],
  );

  assert(realCalls.length === 1, 'real pool called once for SELECT');
  assert(
    (selectResult.rows[0] as { entity_id: string }).entity_id === 'e-real',
    'SELECT returns real pool result',
  );

  // --- Test 3: Multiple writes accumulate in shadow ---
  console.log('\nTest 3: Multiple writes accumulate');
  await proxy.query(occSql, [
    'scope-uuid-1',
    'entity-uuid-2',
    'HASH-A',
    '{"task":"add tests"}',
    'task_spawned',
  ]);
  await proxy.query(occSql, [
    'scope-uuid-1',
    'entity-uuid-3',
    'HASH-B',
    '{"memo":"updated"}',
    'memory_updated',
  ]);

  assert(shadow.getEntries().length === 3, '3 entries total after 2 more writes');
  assert(realCalls.length === 1, 'still only 1 real pool call (the SELECT)');

  // --- Test 4: clear() destroys all shadow entries (阅后即焚) ---
  console.log('\nTest 4: clear() — 阅后即焚');
  shadow.clear();
  assert(shadow.getEntries().length === 0, 'shadow entries cleared');

  // --- Test 5: DO NOTHING variant (OCC_WRITE_DO_NOTHING_SQL prefix is identical) ---
  console.log('\nTest 5: DO NOTHING OCC variant also intercepted');
  const doNothingSql = `WITH new_version AS (
    INSERT INTO execution_event_log_202506
    (scope_id, entity_id, predecessor_hash, payload, event_type)
    VALUES ($1::uuid, $2::uuid, $3, $4::text, 'memory_updated')
    ON CONFLICT DO NOTHING
  )
  SELECT version_hash, event_type, occ_result FROM new_version`;

  await proxy.query(doNothingSql, [
    'scope-uuid-1',
    'entity-uuid-4',
    'HASH-C',
    '{"memo":"idempotent"}',
  ]);
  assert(shadow.getEntries().length === 1, 'DO NOTHING variant also captured');

  console.log('\n✓ All tests passed — InMemoryShadowAdapter validated\n');
  console.log('Key findings:');
  console.log('  - OCC write detection: sql.trimStart().startsWith("WITH new_version AS")');
  console.log('  - Params order: [scopeId, entityId, predecessorHash, canonicalText, eventType?]');
  console.log('  - Fake WriteResult (occ_result=won) satisfies occWrite() return type');
  console.log('  - Real pool only receives SELECT/non-OCC queries');
  console.log('  - clear() is the 阅后即焚 mechanism');
  console.log('  - No PostgreSQL required — pure in-process interception');
}

run().catch((err) => {
  console.error('Spike failed:', err);
  process.exit(1);
});
