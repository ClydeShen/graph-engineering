/**
 * frontier.test.ts — FrontierScheduler skill-matching extension tests
 *
 * GATE4-5: FrontierScheduler dispatches tasks by skill match (not arbitrary assignment).
 * Turned GREEN by: Plan 03-03 (FrontierScheduler skill-matching extension).
 *
 * These RED stubs define the expected behavior for the skill-based dispatch extension.
 * Existing dynamicScore / TokenBucket / SQL structure tests are in
 * src/__tests__/frontier.test.ts (Phase 1, unchanged).
 *
 * Per D-1 (locked): required_skills is declared in task payload; agent_registry
 * provides the skill→agent mapping; FrontierScheduler queries agent_registry via
 * GIN index (`skills && required_skills`) before SKIP LOCKED dispatch.
 * Tasks without required_skills pass through the existing dispatch path unchanged.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import {
  FrontierSchedulerWorker,
  SKILL_MATCH_SQL,
} from './frontier.worker.js';
import { TokenBucket } from './token-bucket.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal mock pool.query that returns the given rows in sequence. */
function buildMockPool(queryResults: Array<{ rows: unknown[] }>): Pool {
  let callCount = 0;
  const mockQuery = vi.fn().mockImplementation(() => {
    const result = queryResults[callCount] ?? { rows: [] };
    callCount++;
    return Promise.resolve(result as QueryResult);
  });
  return { query: mockQuery } as unknown as Pool;
}

/** Build a TokenBucket that always grants (no throttle) for test isolation. */
function unblockedBucket(): TokenBucket {
  const b = new TokenBucket();
  vi.spyOn(b, 'tryAcquire').mockReturnValue(true);
  return b;
}

// ---------------------------------------------------------------------------
// GATE4-5 tests
// ---------------------------------------------------------------------------

describe('FrontierScheduler skill-matching (GATE4-5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ── GATE4-5a: task with required_skills dispatches when GIN-matched agent exists ──

  it('GATE4-5a: task with required_skills dispatches when a GIN-matched active agent exists', async () => {
    // Mock pool.query call sequence:
    //  1. ACTIVE_COUNT_SQL  → { count: 0 }
    //  2. FRONTIER_PRIORITY_SQL → one row with required_skills=['test-skill'] in payload
    //  3. SKILL_MATCH_SQL → match found (1 row)
    //  4. DISPATCH_SQL → no return value needed
    const pool = buildMockPool([
      { rows: [{ count: 0 }] },
      {
        rows: [
          {
            id: 1,
            entity_id: 'entity-a',
            event_type: 'task_spawned',
            dynamic_score: 50,
            payload: JSON.stringify({ required_skills: ['test-skill'] }),
          },
        ],
      },
      { rows: [{ '?column?': 1 }] }, // skill match found
      { rows: [] },                   // DISPATCH_SQL result
    ]);

    const worker = new FrontierSchedulerWorker(pool, unblockedBucket());
    await worker.onFrontierChanged('scope-a');

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    // DISPATCH_SQL is the last call; its first arg includes id=1
    const dispatchCall = mockQuery.mock.calls[3];
    expect(dispatchCall).toBeDefined();
    const dispatchedIds = dispatchCall[1][0] as number[];
    expect(dispatchedIds).toContain(1);
  });

  // ── GATE4-5b: task with required_skills excluded when no matching agent ────────

  it('GATE4-5b: task with required_skills is excluded from dispatch when no matching agent exists', async () => {
    // Mock pool.query call sequence:
    //  1. ACTIVE_COUNT_SQL  → { count: 0 }
    //  2. FRONTIER_PRIORITY_SQL → one row with required_skills=['missing-skill']
    //  3. SKILL_MATCH_SQL → no match (0 rows)
    //  (DISPATCH_SQL should NOT be called because the only candidate was filtered out)
    const pool = buildMockPool([
      { rows: [{ count: 0 }] },
      {
        rows: [
          {
            id: 2,
            entity_id: 'entity-b',
            event_type: 'task_spawned',
            dynamic_score: 40,
            payload: JSON.stringify({ required_skills: ['missing-skill'] }),
          },
        ],
      },
      { rows: [] }, // no skill match
    ]);

    const worker = new FrontierSchedulerWorker(pool, unblockedBucket());
    await worker.onFrontierChanged('scope-b');

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    // DISPATCH_SQL must NOT have been called (only 3 queries total)
    expect(mockQuery).toHaveBeenCalledTimes(3);
    // Verify SKILL_MATCH_SQL was the last call made
    const skillCall = mockQuery.mock.calls[2];
    expect(skillCall[0]).toContain('agent_registry');
  });

  // ── GATE4-5c: task without required_skills passes through unchanged ────────────

  it('GATE4-5c: task without required_skills dispatches unchanged (existing dispatch path, no skill filter)', async () => {
    // Mock pool.query call sequence:
    //  1. ACTIVE_COUNT_SQL  → { count: 0 }
    //  2. FRONTIER_PRIORITY_SQL → one row with no required_skills in payload
    //  3. DISPATCH_SQL → success (no SKILL_MATCH_SQL call — opt-in passthrough)
    const pool = buildMockPool([
      { rows: [{ count: 0 }] },
      {
        rows: [
          {
            id: 3,
            entity_id: 'entity-c',
            event_type: 'task_spawned',
            dynamic_score: 30,
            payload: JSON.stringify({ some_field: 'value' }), // no required_skills
          },
        ],
      },
      { rows: [] }, // DISPATCH_SQL
    ]);

    const worker = new FrontierSchedulerWorker(pool, unblockedBucket());
    await worker.onFrontierChanged('scope-c');

    const mockQuery = pool.query as ReturnType<typeof vi.fn>;
    // Exactly 3 queries: ACTIVE_COUNT, FRONTIER_PRIORITY, DISPATCH — no SKILL_MATCH
    expect(mockQuery).toHaveBeenCalledTimes(3);
    // DISPATCH_SQL is query #3; verify id=3 was dispatched
    const dispatchCall = mockQuery.mock.calls[2];
    const dispatchedIds = dispatchCall[1][0] as number[];
    expect(dispatchedIds).toContain(3);
  });
});

// ---------------------------------------------------------------------------
// SKILL_MATCH_SQL structural assertions
// ---------------------------------------------------------------------------

describe('SKILL_MATCH_SQL', () => {
  it('uses GIN && operator for skill overlap', () => {
    expect(SKILL_MATCH_SQL).toMatch(/skills\s*&&\s*\$1/);
  });

  it('filters status=active', () => {
    expect(SKILL_MATCH_SQL).toMatch(/status\s*=\s*'active'/);
  });

  it('uses AGENT_HEARTBEAT_TTL_S parameter (not a hardcoded literal)', () => {
    // The TTL must be passed as a parameter ($2), not hardcoded as a number
    expect(SKILL_MATCH_SQL).toMatch(/\$2/);
    // Ensure no hardcoded '60' literal seconds in the SQL
    expect(SKILL_MATCH_SQL).not.toMatch(/INTERVAL\s+'60/i);
  });

  it('includes LIMIT 1 (existence check, not full result set)', () => {
    expect(SKILL_MATCH_SQL).toMatch(/LIMIT\s+1/i);
  });
});
