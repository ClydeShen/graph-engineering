/**
 * Unit tests for ScopeConvergenceTracker (Convergence Watchdog).
 *
 * Uses a mock pool — no real PostgreSQL connection required.
 * Tests the 3-tier defense logic:
 *   - Tier 1 guards: does NOT emit scope_closed when pendingTasks > 0
 *   - Full path: DOES emit scope_closed when counters zero + SQL returns converged
 *
 * @see ADR 19 — Convergence Watchdog 3-tier defense
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScopeConvergenceTracker } from '../../packages/control-plane/src/watchdog.js';

// ── Mock pool factory ─────────────────────────────────────────────────────────

function makeMockPool(convergenceResult: { is_converged: boolean; no_open_conflicts: boolean }) {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      // Convergence SQL returns the mock result
      if (sql.includes('is_converged')) {
        return Promise.resolve({ rows: [convergenceResult] });
      }
      // INSERT scope_closed and UPDATE scope_lineage return empty rows
      return Promise.resolve({ rows: [] });
    }),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ScopeConvergenceTracker', () => {
  const SCOPE_ID = '11111111-1111-4111-a111-111111111111';

  describe('Tier 1 guard: pendingTasks > 0', () => {
    it('does NOT emit scope_closed when pendingTasks > 0', async () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      tracker.incrementPendingTasks(SCOPE_ID);
      const closed = await tracker.checkAndClose(SCOPE_ID);

      expect(closed).toBe(false);
      // DB should NOT have been queried — Tier 1 short-circuits
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('does NOT emit scope_closed when openConflicts > 0', async () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      tracker.incrementOpenConflicts(SCOPE_ID);
      const closed = await tracker.checkAndClose(SCOPE_ID);

      expect(closed).toBe(false);
      expect(pool.query).not.toHaveBeenCalled();
    });

    it('does NOT emit scope_closed when both pendingTasks and openConflicts > 0', async () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      tracker.incrementPendingTasks(SCOPE_ID);
      tracker.incrementOpenConflicts(SCOPE_ID);
      const closed = await tracker.checkAndClose(SCOPE_ID);

      expect(closed).toBe(false);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });

  describe('Full convergence path: counters zero + SQL returns converged', () => {
    it('emits scope_closed when Tier 1 counters are zero and DB confirms convergence', async () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      // counters are zero by default
      const closed = await tracker.checkAndClose(SCOPE_ID);

      expect(closed).toBe(true);
      // DB should have been queried (convergence SQL + INSERT scope_closed + UPDATE scope_lineage)
      expect(pool.query).toHaveBeenCalled();
      // First DB call must be the convergence SQL
      const firstCallSql = (pool.query.mock.calls[0] as [string])[0];
      expect(firstCallSql).toContain('is_converged');
    });

    it('does NOT emit scope_closed when DB says is_converged=false', async () => {
      const pool = makeMockPool({ is_converged: false, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      const closed = await tracker.checkAndClose(SCOPE_ID);

      expect(closed).toBe(false);
      // Only the convergence SQL was called — no INSERT
      expect(pool.query).toHaveBeenCalledTimes(1);
    });

    it('does NOT emit scope_closed when DB says no_open_conflicts=false', async () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: false });
      const tracker = new ScopeConvergenceTracker(pool as never);

      const closed = await tracker.checkAndClose(SCOPE_ID);

      expect(closed).toBe(false);
      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('Counter management', () => {
    it('increments and decrements pendingTasks correctly', () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      expect(tracker.getPendingTasks(SCOPE_ID)).toBe(0);
      tracker.incrementPendingTasks(SCOPE_ID);
      tracker.incrementPendingTasks(SCOPE_ID);
      expect(tracker.getPendingTasks(SCOPE_ID)).toBe(2);
      tracker.decrementPendingTasks(SCOPE_ID);
      expect(tracker.getPendingTasks(SCOPE_ID)).toBe(1);
    });

    it('does not decrement below zero', () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      tracker.decrementPendingTasks(SCOPE_ID);
      expect(tracker.getPendingTasks(SCOPE_ID)).toBe(0);
    });
  });

  describe('Tier 2: concurrent close lock', () => {
    it('does not double-emit scope_closed on concurrent checkAndClose calls', async () => {
      const pool = makeMockPool({ is_converged: true, no_open_conflicts: true });
      const tracker = new ScopeConvergenceTracker(pool as never);

      // Fire two concurrent checkAndClose calls
      const [r1, r2] = await Promise.all([
        tracker.checkAndClose(SCOPE_ID),
        tracker.checkAndClose(SCOPE_ID),
      ]);

      // Exactly one should succeed, the other blocked by Tier 2 lock
      const successCount = [r1, r2].filter(Boolean).length;
      expect(successCount).toBe(1);
    });
  });
});
