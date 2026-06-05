/**
 * ScopeConvergenceTracker — 3-tier Convergence Watchdog.
 *
 * This class is the SOLE emitter of `scope_closed` within the Control Plane Daemon.
 * (The Gateway separately holds ADR-24 infra-write rights for scope_closed via
 * its inline Watchdog SQL path — that is a separate, independently authorised path.)
 *
 * 3-tier defense:
 *   Tier 1: In-memory atomic counters (pendingTasks, openConflicts per scope)
 *   Tier 2: Per-scope conflict lock (Set<scopeId>) — prevents concurrent close races
 *   Tier 3: DB terminal SQL — confirms no non-terminal events, no open conflicts
 *
 * Context OOM 3-tier chain (ADR 13 supplement):
 *   Tier 1: LLM distillation of N_root
 *   Tier 2: Tail-truncate N_current to last 2000 tokens
 *   Tier 3: Direct-write context_oom_throttled and mark scope Suspended
 *
 * @see ADR 19 — Convergence Watchdog 3-tier defense
 * @see ADR 28 — Scheduling spec and operational determinism
 * @see docs/adr/0024-adr13-supplement-context-oom-degradation.md — OOM 3-tier chain
 */
import type { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { ZERO_HASH, logger, LOG_EVENTS, canonicalJson } from '@graph/shared';

const log = logger.child({ component: 'control-plane', module: 'watchdog' });

// ── Tier 3 convergence SQL ────────────────────────────────────────────────────
// Source: ADR 19 / RESEARCH.md §Convergence Watchdog SQL
const CONVERGENCE_SQL = `
  SELECT
    NOT EXISTS (
      SELECT 1 FROM execution_event_log
      WHERE scope_id = $1
        AND status NOT IN ('terminated', 'archived')
        AND event_type NOT IN ('scope_closed', 'conflict_detected')
    ) AS is_converged,
    NOT EXISTS (
      SELECT 1 FROM execution_event_log
      WHERE scope_id = $1
        AND event_type = 'conflict_detected'
        AND status != 'resolved'
    ) AS no_open_conflicts
`;

export class ScopeConvergenceTracker {
  // Tier 1: in-memory counters per scope.
  // On process restart these reset to 0, causing checkAndClose() to skip the
  // Tier 1 fast-path and fall through to the authoritative Tier 3 SQL check.
  // This is intentional: Tier 3 is the only hard guard; Tier 1 is a performance
  // optimisation that avoids a DB round-trip for the common case.
  private readonly pendingTasks = new Map<string, number>();
  private readonly openConflicts = new Map<string, number>();

  // Tier 2: per-scope conflict lock (guards concurrent close checks)
  private readonly closeLock = new Set<string>();

  constructor(private readonly pool: Pool) {}

  // ── Tier 1 counter management ─────────────────────────────────────────────

  incrementPendingTasks(scopeId: string): void {
    this.pendingTasks.set(scopeId, (this.pendingTasks.get(scopeId) ?? 0) + 1);
  }

  decrementPendingTasks(scopeId: string): void {
    const current = this.pendingTasks.get(scopeId) ?? 0;
    this.pendingTasks.set(scopeId, Math.max(0, current - 1));
  }

  incrementOpenConflicts(scopeId: string): void {
    this.openConflicts.set(scopeId, (this.openConflicts.get(scopeId) ?? 0) + 1);
  }

  decrementOpenConflicts(scopeId: string): void {
    const current = this.openConflicts.get(scopeId) ?? 0;
    this.openConflicts.set(scopeId, Math.max(0, current - 1));
  }

  getPendingTasks(scopeId: string): number {
    return this.pendingTasks.get(scopeId) ?? 0;
  }

  getOpenConflicts(scopeId: string): number {
    return this.openConflicts.get(scopeId) ?? 0;
  }

  /**
   * Check Tier 1 counters, acquire Tier 2 lock, run Tier 3 SQL.
   * If all three tiers confirm convergence, INSERT scope_closed.
   *
   * This is the ONLY code path that emits scope_closed within the Control Plane Daemon.
   */
  async checkAndClose(scopeId: string): Promise<boolean> {
    // Tier 1: fast-path — skip if counters indicate non-zero pending work
    if (this.getPendingTasks(scopeId) > 0 || this.getOpenConflicts(scopeId) > 0) {
      return false;
    }

    // Tier 2: acquire per-scope lock to prevent concurrent close races
    if (this.closeLock.has(scopeId)) {
      return false; // another checkAndClose is running for this scope
    }
    this.closeLock.add(scopeId);

    try {
      // Tier 3: DB terminal SQL — authoritative check
      const result = await this.pool.query<{
        is_converged: boolean;
        no_open_conflicts: boolean;
      }>(CONVERGENCE_SQL, [scopeId]);

      const row = result.rows[0];
      if (!row || !row.is_converged || !row.no_open_conflicts) {
        return false;
      }

      // All 3 tiers confirm convergence — emit scope_closed
      // This is the ONLY place scope_closed is emitted in the Control Plane Daemon
      const entityId = randomUUID();
      const canonicalPayload = canonicalJson({ scope_id: scopeId });

      await this.pool.query(
        `INSERT INTO execution_event_log
           (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
         SELECT
           $1::uuid,
           $2::uuid,
           'scope_closed',
           version_hash,
           encode(
             digest(
               $1::text || '|' || $2::text || '|' || version_hash
                 || '|scope_closed|' || $3,
               'sha256'
             ),
             'hex'
           ),
           $3,
           'terminated'
         FROM execution_event_log
         WHERE scope_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [scopeId, entityId, canonicalPayload],
      );

      // Update scope_lineage status to closed
      await this.pool.query(
        `UPDATE scope_lineage SET status = 'closed' WHERE scope_id = $1`,
        [scopeId],
      );

      // Non-blocking refresh of materialized traversal cache (migration 009).
      // CONCURRENTLY does not block readers — fire-and-forget is safe.
      this.pool
        .query('REFRESH MATERIALIZED VIEW CONCURRENTLY scope_lineage_view')
        .catch((err: unknown) =>
          log.warn({ err }, 'scope_lineage_view refresh failed — fallback active'),
        );

      return true;
    } finally {
      this.closeLock.delete(scopeId);
    }
  }

  /**
   * Handle Context OOM — 3-tier degradation chain.
   * @see docs/adr/0024-adr13-supplement-context-oom-degradation.md
   *
   * @param scopeId  The scope experiencing OOM
   * @param tier     Which tier to invoke (1 = LLM distill, 2 = truncate, 3 = throttle)
   */
  async handleContextOom(scopeId: string, tier: 1 | 2 | 3): Promise<void> {
    if (tier === 1) {
      // LLM CALL — justified by ADR 13 supplement (Context OOM degradation chain)
      log.warn({ scope_id: scopeId, tier: 1 }, LOG_EVENTS.CONTEXT_OOM + ' LLM distill N_root');
      // Stub: in production, call LLMProvider.chat() to distill N_root content.
    } else if (tier === 2) {
      log.warn({ scope_id: scopeId, tier: 2 }, LOG_EVENTS.CONTEXT_OOM + ' tail-truncate N_current 2000 tokens');
      // Stub: in production, apply sliding-window truncation via @dqbd/tiktoken.
    } else {
      log.error({ scope_id: scopeId, tier: 3 }, LOG_EVENTS.CONTEXT_OOM + ' writing context_oom_throttled, suspending scope');
      const entityId = randomUUID();
      const canonicalPayload = canonicalJson({
        scope_id: scopeId,
        reason: 'context_oom_throttled',
      });

      await this.pool.query(
        `INSERT INTO execution_event_log
           (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
         SELECT
           $1::uuid,
           $2::uuid,
           'memory_updated',
           version_hash,
           encode(
             digest(
               $1::text || '|' || $2::text || '|' || version_hash
                 || '|memory_updated|' || $3,
               'sha256'
             ),
             'hex'
           ),
           $3,
           'suspended'
         FROM execution_event_log
         WHERE scope_id = $1
         ORDER BY id DESC
         LIMIT 1`,
        [scopeId, entityId, canonicalPayload],
      );

      // Mark scope Suspended in scope_lineage
      await this.pool.query(
        `UPDATE scope_lineage SET status = 'suspended' WHERE scope_id = $1`,
        [scopeId],
      );
    }
  }
}
