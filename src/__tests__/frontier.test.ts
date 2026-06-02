/**
 * Unit tests for the Frontier Scheduler (REQ-19).
 *
 * These tests cover the pure dynamicScore function and the TokenBucket
 * throttle — no database required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dynamicScore, FRONTIER_PRIORITY_SQL, FRONTIER_TRIGGER_CONFIG } from '../../packages/workers/src/scheduler/frontier.worker.js';
import { TokenBucket, WINDOW_MS } from '../../packages/workers/src/scheduler/token-bucket.js';

// ---------------------------------------------------------------------------
// dynamicScore — five-term priority formula
// ---------------------------------------------------------------------------

describe('dynamicScore', () => {
  it('computes the reference case: base=2, ageSec=10, unlocks=3, spawnedBy=1, isActive=1 => 73', () => {
    // base_priority*10 = 2*10 = 20
    // age_bonus = min(10*10, 20) = min(100, 20) = 20
    // unlocks_count*5 = 3*5 = 15
    // spawned_by_bonus = 1*3 = 3
    // active_bonus = 1*15 = 15
    // total = 20 + 20 + 15 + 3 + 15 = 73
    expect(dynamicScore(2, 10, 3, 1, 1)).toBe(73);
  });

  it('age_bonus is capped at 20 regardless of age', () => {
    // ageSec=100 -> min(100*10, 20) = 20 (same as ageSec=10 case)
    const withLargeAge = dynamicScore(1, 100, 0, 0, 0);
    const withSmallAge = dynamicScore(1, 2, 0, 0, 0);   // min(20, 20) = 20
    // both should have age_bonus=20
    expect(withLargeAge).toBe(dynamicScore(1, 2, 0, 0, 0));
    expect(withLargeAge).toBe(10 + 20); // base*10 + age_bonus=20
    expect(withSmallAge).toBe(10 + 20);
  });

  it('age_bonus at the boundary (ageSec=2): min(2*10,20) = 20', () => {
    expect(dynamicScore(0, 2, 0, 0, 0)).toBe(20);
  });

  it('age_bonus below cap (ageSec=1): min(1*10,20) = 10', () => {
    expect(dynamicScore(0, 1, 0, 0, 0)).toBe(10);
  });

  it('spawned_by_bonus is 0 when spawnedBy=0 (default)', () => {
    expect(dynamicScore(1, 0, 0)).toBe(10);     // no spawnedBy, no isActive
    expect(dynamicScore(1, 0, 0, 0, 0)).toBe(10);
  });

  it('spawned_by_bonus adds 3 when spawnedBy=1', () => {
    expect(dynamicScore(1, 0, 0, 1, 0)).toBe(13);
  });

  it('active_bonus adds 15 when isActive=1', () => {
    expect(dynamicScore(1, 0, 0, 0, 1)).toBe(25);
  });

  it('priority 3 levels higher always wins even with max age on lower (inversion impossible at 3+ levels)', () => {
    // base=1 with max age: 10 + 20 = 30
    const lowerWithMaxAge = dynamicScore(1, 100, 0);
    // base=4 with zero age: 40 + 0 = 40  (gap = 30, max age_bonus = 20 < 30)
    const threeHigher = dynamicScore(4, 0, 0);
    expect(lowerWithMaxAge).toBe(30);
    expect(threeHigher).toBe(40);
    expect(threeHigher).toBeGreaterThan(lowerWithMaxAge);
  });
});

// ---------------------------------------------------------------------------
// TokenBucket — 50ms window throttle
// ---------------------------------------------------------------------------

describe('TokenBucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants the first acquisition immediately', () => {
    const bucket = new TokenBucket();
    expect(bucket.tryAcquire()).toBe(true);
  });

  it('blocks a second acquisition within 50ms', () => {
    const bucket = new TokenBucket();
    bucket.tryAcquire();
    vi.advanceTimersByTime(WINDOW_MS - 1); // 49ms later
    expect(bucket.tryAcquire()).toBe(false);
  });

  it('grants again after 50ms have elapsed', () => {
    const bucket = new TokenBucket();
    bucket.tryAcquire();
    vi.advanceTimersByTime(WINDOW_MS); // exactly 50ms later
    expect(bucket.tryAcquire()).toBe(true);
  });

  it('grants again well past the 50ms window', () => {
    const bucket = new TokenBucket();
    bucket.tryAcquire();
    vi.advanceTimersByTime(200);
    expect(bucket.tryAcquire()).toBe(true);
  });

  it('reset() allows immediate re-acquisition', () => {
    const bucket = new TokenBucket();
    bucket.tryAcquire();
    vi.advanceTimersByTime(10);
    bucket.reset();
    expect(bucket.tryAcquire()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural assertions — no LLM in dispatch path, correct SQL shape
// ---------------------------------------------------------------------------

describe('FRONTIER_PRIORITY_SQL', () => {
  it('contains ORDER BY dynamic_score DESC, created_at ASC', () => {
    expect(FRONTIER_PRIORITY_SQL).toMatch(/ORDER BY dynamic_score DESC, created_at ASC/i);
  });

  it('uses LIMIT with a placeholder (Top-K parameterized)', () => {
    expect(FRONTIER_PRIORITY_SQL).toMatch(/LIMIT \$2/);
  });

  it('uses typed columns (not JSONB operators)', () => {
    // Ensure no payload->>'...' pattern — payload is TEXT per ADR 02
    expect(FRONTIER_PRIORITY_SQL).not.toMatch(/payload->>/);
  });
});

describe('FRONTIER_TRIGGER_CONFIG', () => {
  it('identifies the correct function_id', () => {
    expect(FRONTIER_TRIGGER_CONFIG.function_id).toBe('graph::scheduler::frontier');
  });

  it('subscribes to graph::frontier::changed topic', () => {
    expect(FRONTIER_TRIGGER_CONFIG.topic).toBe('graph::frontier::changed');
  });

  it('is a durable:subscriber type', () => {
    expect(FRONTIER_TRIGGER_CONFIG.type).toBe('durable:subscriber');
  });
});
