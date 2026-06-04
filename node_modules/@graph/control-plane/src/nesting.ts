/**
 * 3-phase scope nesting protocol — executed in a single DDL transaction.
 *
 * Phase 1: CREATE PARTITION + OCC constraint + idempotency constraint + pending-lookup index
 * Phase 2: INSERT scope_lineage row (enforcing MAX_CHILD_SCOPE_DEPTH)
 * Phase 3: INSERT plan_created event with ZERO_HASH predecessor and pgcrypto version_hash
 *
 * All three phases run inside a single BEGIN/COMMIT on ddlPool.
 * Any failure causes a full ROLLBACK — no partial state is left.
 *
 * @see ADR 05 — 3-phase nesting protocol in single DDL transaction
 * @see ADR 01 — PARTITION BY LIST(scope_id)
 * @see ADR 11 — OCC UNIQUE(predecessor_hash, scope_id) per partition
 * @see ADR 02 — ZERO_HASH sentinel for plan_created root
 * @see ADR 34 D-7 — MAX_CHILD_SCOPE_DEPTH = 3
 */
import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { ZERO_HASH, MAX_CHILD_SCOPE_DEPTH, canonicalJson } from '@graph/shared';

export interface NestScopeResult {
  scopeId: string;
  planHash: string;
}

/**
 * Validate that a UUID string contains only hex characters and dashes.
 * Used to prevent SQL injection when interpolating scope UUID into DDL strings.
 */
function assertSafeUuidHex(uuid: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
    throw new Error(`Invalid scope UUID format — DDL injection guard: "${uuid}"`);
  }
}

/**
 * Strip dashes from a UUID to produce the partition suffix (hex only, no dashes).
 * Safe for DDL identifier interpolation after assertSafeUuidHex() validation.
 */
function uuidNoDash(uuid: string): string {
  return uuid.replace(/-/g, '');
}

/**
 * Execute the 3-phase scope nesting protocol in a single DDL transaction.
 *
 * @param intent   Human-readable description of the scope's purpose
 * @param parentScopeId  Parent scope UUID for sub-scopes; undefined for root scopes
 * @param depth    Nesting depth (0 = top-level). Enforced <= MAX_CHILD_SCOPE_DEPTH.
 */
export async function nestScope(
  ddlPool: Pool,
  intent: string,
  parentScopeId?: string,
  depth = 0,
): Promise<NestScopeResult> {
  if (depth > MAX_CHILD_SCOPE_DEPTH) {
    throw new Error(
      `Scope nesting depth ${depth} exceeds MAX_CHILD_SCOPE_DEPTH (${MAX_CHILD_SCOPE_DEPTH})`,
    );
  }

  const scopeId = randomUUID();
  // Validate UUID before any DDL interpolation
  assertSafeUuidHex(scopeId);
  const nodash = uuidNoDash(scopeId);

  // Entity ID for the plan_created event (represents the scope entity itself)
  const entityId = randomUUID();

  // canonical payload for plan_created (stripped of _meta / schema_version)
  const canonicalPayload = canonicalJson({ intent });

  const client = await ddlPool.connect();
  try {
    await client.query('BEGIN');

    // ── Phase 1: Create partition sub-table ──────────────────────────────────

    // CREATE PARTITION — one sub-table per Scope (ADR 01)
    await client.query(`
      CREATE TABLE execution_event_log_scope_${nodash}
      PARTITION OF execution_event_log
      FOR VALUES IN ('${scopeId}')
    `);

    // OCC hard-stop: first writer wins (ADR 11)
    await client.query(`
      ALTER TABLE execution_event_log_scope_${nodash}
      ADD CONSTRAINT uk_scope_occ_${nodash}
      UNIQUE (predecessor_hash, scope_id)
    `);

    // Idempotency constraint: at-least-once re-delivery transparent (ADR 32 D-5)
    await client.query(`
      ALTER TABLE execution_event_log_scope_${nodash}
      ADD CONSTRAINT uk_scope_idem_${nodash}
      UNIQUE (scope_id, entity_id, version_hash)
    `);

    // Pending-lookup partial index (ADR 13, ADR 19)
    await client.query(`
      CREATE INDEX idx_scope_${nodash}_pending_lookup
      ON execution_event_log_scope_${nodash} (scope_id, status, event_id ASC)
      WHERE status IN ('pending_scheduling', 'pending_dispatch')
    `);

    // ── Phase 2: INSERT scope_lineage ────────────────────────────────────────
    await client.query(
      `INSERT INTO scope_lineage (scope_id, parent_scope_id, depth, intent)
       VALUES ($1, $2, $3, $4)`,
      [scopeId, parentScopeId ?? null, depth, intent],
    );

    // ── Phase 3: INSERT plan_created event with pgcrypto version_hash ────────
    const insertResult = await client.query<{ version_hash: string }>(
      `INSERT INTO execution_event_log
         (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
       VALUES (
         $1::uuid,
         $2::uuid,
         'plan_created',
         $3,
         encode(
           digest(
             $1::text || '|' || $2::text || '|' || $3 || '|plan_created|' || $4,
             'sha256'
           ),
           'hex'
         ),
         $4,
         'pending_scheduling'
       )
       RETURNING version_hash`,
      [scopeId, entityId, ZERO_HASH, canonicalPayload],
    );

    await client.query('COMMIT');

    const planHash = insertResult.rows[0].version_hash;
    return { scopeId, planHash };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
