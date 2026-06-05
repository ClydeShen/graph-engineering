/**
 * FrontierSchedulerWorker — graph::scheduler::frontier (ADR 31).
 *
 * Subscribes to the graph::frontier::changed topic (durable:subscriber).
 * Computes Top-K priority events via SQL and dispatches them as
 * pending_dispatch rows that PgQueueAdapter consumes (ADR 32 D-4).
 *
 * DISPATCH PATH IS LLM-FREE (ADR 31 invariant): no chat/completions call,
 * no embedding call, no LLM provider interaction of any kind.
 * Priority is pure SQL arithmetic + this Worker's orchestration.
 *
 * Token bucket (50ms window) prevents cascade storms when many Workers
 * complete simultaneously.
 */

import type { Pool } from 'pg';
import { MAX_PARALLELISM, AGENT_HEARTBEAT_TTL_S } from '@shared/constants';
import { TokenBucket } from './token-bucket.js';

// ---------------------------------------------------------------------------
// Registration config — exported so Plan 09 index.ts can register exactly once.
// Do NOT call registerFunction/registerTrigger here; single boot entry point
// in index.ts prevents double-registration.
// ---------------------------------------------------------------------------

export interface TriggerConfig {
  type: 'durable:subscriber';
  function_id: string;
  config: { topic: string };
}

/** Trigger registration config for Plan 09 index.ts. */
export const FRONTIER_TRIGGER_CONFIG: TriggerConfig = {
  type: 'durable:subscriber',
  function_id: 'graph::scheduler::frontier',
  config: { topic: 'graph::frontier::changed' },
};

// ---------------------------------------------------------------------------
// Priority SQL (ADR 31, REQ-19).
//
// Uses typed columns on execution_event_log — NOT payload->>'...' JSONB
// operators (payload is TEXT per ADR 02; typed columns defined in
// migrations/002-event-log.sql).
//
// Formula: base_priority*10 + LEAST(age_seconds*10, 20) + unlocks_count*5
//        + spawned_by_bonus(3 if spawned_by IS NOT NULL)
//        + active_bonus(15 if last_active_at > NOW()-5s)
//
// Tie-break: created_at ASC (FIFO).
// ---------------------------------------------------------------------------

export const FRONTIER_PRIORITY_SQL = `
  WITH frontier_nodes AS (
    SELECT
      id,
      entity_id,
      event_type,
      created_at,
      base_priority,
      unlocks_count,
      spawned_by,
      last_active_at,
      payload,
      LEAST(
        EXTRACT(EPOCH FROM (NOW() - created_at))::numeric * 10,
        20
      ) AS age_bonus
    FROM execution_event_log
    WHERE status = 'pending_scheduling'
      AND scope_id = $1
  )
  SELECT
    id,
    entity_id,
    event_type,
    payload,
    (
      base_priority * 10
      + age_bonus
      + unlocks_count * 5
      + CASE WHEN spawned_by IS NOT NULL THEN 3 ELSE 0 END
      + CASE WHEN last_active_at > NOW() - INTERVAL '5 seconds' THEN 15 ELSE 0 END
    ) AS dynamic_score
  FROM frontier_nodes
  ORDER BY dynamic_score DESC, created_at ASC
  LIMIT $2
`;

/**
 * Skill availability check — does at least one active, fresh-heartbeat agent
 * exist whose skills overlap the task's required_skills?
 *
 * $1 — required_skills as text[]
 * $2 — AGENT_HEARTBEAT_TTL_S (passed as parameter; not hardcoded)
 *
 * GIN index idx_agent_registry_skills (migration 007) makes && O(log N).
 * Returns 1 row if a match exists, 0 rows if none.
 *
 * Per D-1: this is the ONLY routing signal. assigned_agent_id is forbidden.
 */
export const SKILL_MATCH_SQL = `
  SELECT 1
  FROM agent_registry
  WHERE status = 'active'
    AND skills && $1::text[]
    AND last_heartbeat > NOW() - ($2 || ' seconds')::interval
  LIMIT 1
`;

/** Mark selected frontier nodes as pending_dispatch (idempotent guard). */
const DISPATCH_SQL = `
  UPDATE execution_event_log
  SET status = 'pending_dispatch', dispatched_at = NOW()
  WHERE id = ANY($1::int[])
    AND status = 'pending_scheduling'
`;

/** Count active (processing) workers for a scope. */
const ACTIVE_COUNT_SQL = `
  SELECT COUNT(*)::int AS count
  FROM execution_event_log
  WHERE status = 'processing'
    AND scope_id = $1
`;

// ---------------------------------------------------------------------------
// Pure score function for unit tests (no DB, no LLM).
// ---------------------------------------------------------------------------

/**
 * Compute the five-term dynamic priority score.
 *
 * Parameters mirror the SQL formula exactly:
 *   base      — base_priority column value
 *   ageSec    — seconds since created_at
 *   unlocks   — unlocks_count column value
 *   spawnedBy — 1 if spawned_by IS NOT NULL, else 0
 *   isActive  — 1 if last_active_at > NOW()-5s, else 0
 *
 * No LLM call in this function (ADR 31 LLM-free dispatch invariant).
 */
export function dynamicScore(
  base: number,
  ageSec: number,
  unlocks: number,
  spawnedBy: number = 0,
  isActive: number = 0,
): number {
  const ageBonus = Math.min(ageSec * 10, 20);
  return base * 10 + ageBonus + unlocks * 5 + spawnedBy * 3 + isActive * 15;
}

// ---------------------------------------------------------------------------
// Worker class
// ---------------------------------------------------------------------------

export class FrontierSchedulerWorker {
  private readonly pool: Pool;
  private readonly bucket: TokenBucket;

  constructor(pool: Pool, bucket: TokenBucket = new TokenBucket()) {
    this.pool = pool;
    this.bucket = bucket;
  }

  /**
   * Handler for graph::frontier::changed events.
   *
   * Token bucket gate: if a cycle ran within the last 50ms, this invocation
   * is a no-op (cascade storm prevention per ADR 31).
   *
   * When the gate passes:
   *  1. Count active workers for the scope.
   *  2. If remaining slots > 0, run Top-K priority SQL.
   *  3. Partition candidates: tasks without required_skills pass through
   *     unchanged (Pitfall 4 opt-in rule); tasks with required_skills are
   *     gated on an agent_registry GIN skill-match check (D-1).
   *  4. Atomically mark eligible rows as pending_dispatch.
   *
   * No LLM call anywhere in this method — dispatch path is LLM-free (ADR 31).
   * No assigned_agent_id / preferred_agent is ever read (D-1 invariant).
   */
  async onFrontierChanged(scopeId: string): Promise<void> {
    if (!this.bucket.tryAcquire()) {
      return;
    }

    // Count active workers to determine remaining capacity.
    const activeResult = await this.pool.query(ACTIVE_COUNT_SQL, [scopeId]);
    const activeCount = (activeResult.rows[0]?.count as number) ?? 0;
    const remaining = MAX_PARALLELISM - activeCount;

    if (remaining <= 0) {
      return;
    }

    // Select Top-K frontier nodes by dynamic_score.
    // FRONTIER_PRIORITY_SQL now returns `payload` (TEXT) so we can parse
    // required_skills; all score arithmetic is byte-for-byte unchanged (ADR 31).
    const frontierResult = await this.pool.query(FRONTIER_PRIORITY_SQL, [
      scopeId,
      remaining,
    ]);

    if (frontierResult.rows.length === 0) {
      return;
    }

    // Partition: passthrough vs. skill-gated rows.
    const eligibleIds: number[] = [];

    for (const row of frontierResult.rows) {
      // Parse payload — TEXT column per ADR 02.
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(row.payload as string) as Record<string, unknown>;
      } catch {
        // Malformed payload: treat as no required_skills → passthrough.
      }

      // D-1 violation guard: log and ignore forbidden assignment fields.
      if ('assigned_agent_id' in parsed || 'preferred_agent' in parsed) {
        console.warn(
          '[FrontierScheduler] D-1 violation: task payload contains forbidden ' +
            'assignment field (assigned_agent_id / preferred_agent). ' +
            'Field ignored — only required_skills is honored.',
          { id: row.id },
        );
        // Strip the forbidden fields; routing continues via required_skills only.
        delete parsed['assigned_agent_id'];
        delete parsed['preferred_agent'];
      }

      const requiredSkills = parsed['required_skills'];

      // Opt-in: tasks without required_skills (or empty array) pass through
      // unchanged (Pitfall 4 — preserves legacy dispatch for all existing tasks).
      if (!Array.isArray(requiredSkills) || requiredSkills.length === 0) {
        eligibleIds.push(row.id as number);
        continue;
      }

      // Skill-gated: check agent_registry for an active, fresh-heartbeat agent
      // whose skills overlap the task's required_skills (GIN && operator, D-1).
      const matchResult = await this.pool.query(SKILL_MATCH_SQL, [
        requiredSkills,
        String(AGENT_HEARTBEAT_TTL_S),
      ]);

      if (matchResult.rows.length > 0) {
        eligibleIds.push(row.id as number);
      }
      // No match → task remains pending_scheduling for the next dispatch cycle.
    }

    if (eligibleIds.length === 0) {
      return;
    }

    // Atomically mark eligible rows as pending_dispatch (AND status guard
    // prevents double-dispatch on concurrent scheduler firings).
    await this.pool.query(DISPATCH_SQL, [eligibleIds]);
  }
}
