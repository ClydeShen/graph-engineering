/**
 * Session → Scope stable mapping (TD-E, Phase 11).
 *
 * Replaces the Phase 6 MVP behavior (fresh randomUUID scope per message) with a
 * graph-stored mapping: the session key lives in scope_lineage.intent as
 * `session:<key>`, so the mapping survives restarts, is shared across replicas,
 * and Phase 12 cross-platform continuation can find it by querying the graph.
 *
 * Lifecycle:
 *   - live session scope (status='active', last event within idle timeout) → reuse;
 *     the scope tip hash becomes the next event's predecessor (context accumulates
 *     in the graph and Knapsack assembles it).
 *   - idle-expired → close the old scope (scope_closed event + lineage status),
 *     then open a fresh scope under the same session intent. Session history =
 *     all scopes sharing the intent key.
 *   - none → nestScope (Control Plane 3-phase DDL protocol).
 *
 * Concurrency: a pg advisory lock on the session key serializes concurrent
 * messages for the same session, preventing duplicate scope creation.
 *
 * @see .planning/phases/11-memex-shell/11-PHASE-SPEC.md §2b
 */

import type { Pool } from 'pg';
import { canonicalJson, writeInfraEvent } from '@graph/shared';
import { nestScope } from '@graph/control-plane/nesting';

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function sessionIntent(sessionKey: string): string {
  return `session:${sessionKey}`;
}

export interface SessionScope {
  scopeId: string;
  /** Tip hash of the resumed scope, or planHash of a fresh scope. */
  predecessorHash: string;
  resumed: boolean;
}

/**
 * Cross-platform continuation (Phase 12 deliverable #5): continue an EXPLICIT
 * scope from any channel. The state lives in the graph — same Trail, new
 * platform; Knapsack assembles the context from the shared scope. Identity-
 * based automatic continuation (same_as) is Phase 13.
 *
 * Returns null when the scope does not exist or is already closed.
 */
export async function resolveScopeTip(
  pool: Pool,
  scopeId: string,
): Promise<{ scopeId: string; predecessorHash: string } | null> {
  const { rows: lineage } = await pool.query<{ status: string }>(
    `SELECT status FROM scope_lineage WHERE scope_id = $1`,
    [scopeId],
  );
  if (lineage.length === 0 || lineage[0]!.status !== 'active') return null;

  const { rows: tip } = await pool.query<{ version_hash: string }>(
    `SELECT version_hash FROM execution_event_log
     WHERE scope_id = $1 ORDER BY id DESC LIMIT 1`,
    [scopeId],
  );
  if (tip.length === 0) return null;
  return { scopeId, predecessorHash: tip[0]!.version_hash };
}

export async function resolveSessionScope(
  pool: Pool,
  sessionKey: string,
  idleTimeoutMs: number = SESSION_IDLE_TIMEOUT_MS,
): Promise<SessionScope> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [sessionKey]);

    const { rows } = await client.query<{ scope_id: string }>(
      `SELECT scope_id FROM scope_lineage
       WHERE intent = $1 AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      [sessionIntent(sessionKey)],
    );

    if (rows.length > 0) {
      const scopeId = rows[0]!.scope_id;
      const tip = await client.query<{ version_hash: string; created_at: Date }>(
        `SELECT version_hash, created_at FROM execution_event_log
         WHERE scope_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [scopeId],
      );

      if (tip.rows.length > 0) {
        const lastActiveAt = tip.rows[0]!.created_at.getTime();
        if (Date.now() - lastActiveAt <= idleTimeoutMs) {
          return { scopeId, predecessorHash: tip.rows[0]!.version_hash, resumed: true };
        }

        // Idle-expired: close the stale session scope (infra-write right, shared
        // implementation with the Gateway watchdog — also flips scope_lineage to
        // 'closed'), then fall through to a fresh one. Best-effort: close failure
        // must not block the new session.
        try {
          await writeInfraEvent(
            pool,
            scopeId,
            'scope_closed',
            canonicalJson({ scope_id: scopeId, reason: 'session_idle_timeout' }),
            'terminated',
          );
        } catch {
          /* stale-scope close is best-effort */
        }
      }
    }

    // Fresh session scope via the Control Plane's 3-phase DDL nesting protocol.
    const { scopeId, planHash } = await nestScope(pool, sessionIntent(sessionKey));
    return { scopeId, predecessorHash: planHash, resumed: false };
  } finally {
    await client
      .query('SELECT pg_advisory_unlock(hashtext($1))', [sessionKey])
      .catch(() => {});
    client.release();
  }
}
