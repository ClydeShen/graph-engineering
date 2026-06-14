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
 * Additional exports:
 *   createSubScope — wraps nestScope for spawn_sub_scope interception
 *   resolveSubScope — direct-writes sub_scope_resolved to parent partition (ADR 23)
 *
 * @see ADR 05 — 3-phase nesting protocol in single DDL transaction
 * @see ADR 01 — PARTITION BY LIST(scope_id)
 * @see ADR 11 — OCC UNIQUE(predecessor_hash, scope_id) per partition
 * @see ADR 02 — ZERO_HASH sentinel for plan_created root
 * @see ADR 23 — sub_scope_resolved direct-write (Control Plane only)
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
  project?: string,
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
    // project (CONSOLE-REDESIGN §11.1) is an optional workspace dimension. When
    // omitted the original 4-column INSERT runs unchanged — zero-regression for
    // every current caller and safe even before migration 022. The 5-column form
    // is taken only when a caller explicitly passes a project (requires 022).
    if (project !== undefined) {
      await client.query(
        `INSERT INTO scope_lineage (scope_id, parent_scope_id, depth, intent, project)
         VALUES ($1, $2, $3, $4, $5)`,
        [scopeId, parentScopeId ?? null, depth, intent, project],
      );
    } else {
      await client.query(
        `INSERT INTO scope_lineage (scope_id, parent_scope_id, depth, intent)
         VALUES ($1, $2, $3, $4)`,
        [scopeId, parentScopeId ?? null, depth, intent],
      );
    }

    // ── Phase 3: INSERT plan_created event with pgcrypto version_hash ────────
    const insertResult = await client.query<{ id: string; version_hash: string }>(
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
       RETURNING id, version_hash`,
      [scopeId, entityId, ZERO_HASH, canonicalPayload],
    );

    await client.query('COMMIT');

    // Pulse the realtime stream so observers (Now universe, dashboard) learn a
    // scope was born at creation time — not only when its first occWrite lands.
    // Without this, a brand-new galaxy/scope is invisible to /v1/stream until the
    // next occWrite, so the Now universe needed a manual refresh. Same
    // graph_event_ready contract as occWrite (JSON {id}); best-effort — the scope
    // is already committed, so a notify failure must not fail nesting.
    try {
      await client.query("SELECT pg_notify('graph_event_ready', $1::text)", [
        JSON.stringify({ id: Number(insertResult.rows[0].id) }),
      ]);
    } catch {
      /* notify is best-effort; the COMMIT above is the source of truth */
    }

    const planHash = insertResult.rows[0].version_hash;
    return { scopeId, planHash };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Create a child scope from a spawn_sub_scope interception.
 *
 * Delegates to nestScope for the full 3-phase DDL protocol and returns the
 * child scopeId + planHash. The triggerTaskId is the parent's task_spawned
 * entity_id; it is NOT stored in scope_lineage (the real schema has no such
 * column) but is embedded in the sub_scope_resolved payload by resolveSubScope.
 *
 * Depth enforcement is inherited from nestScope (throws if depth > MAX_CHILD_SCOPE_DEPTH).
 *
 * @see ADR 23 — nested scope activation (Phase 3)
 * @see ADR 34 D-7 — MAX_CHILD_SCOPE_DEPTH = 3
 */
export async function createSubScope(
  ddlPool: Pool,
  intent: string,
  parentScopeId: string,
  triggerTaskId: string,
  depth: number,
): Promise<NestScopeResult> {
  // Depth enforcement — reuses nestScope's guard (throws with MAX_CHILD_SCOPE_DEPTH message)
  // triggerTaskId is not stored in DB (scope_lineage has no such column per migration 005)
  // It is carried to resolveSubScope by the caller and embedded in sub_scope_resolved payload
  void triggerTaskId;
  return nestScope(ddlPool, intent, parentScopeId, depth);
}

/**
 * Direct-write sub_scope_resolved to the parent partition after a child scope closes.
 *
 * Follows the watchdog.ts context_oom_throttled direct-write pattern exactly:
 *   - SELECT parent_scope_id from scope_lineage
 *   - If no parent (root scope): return without writing (no-op)
 *   - Read child's final version_hash (last row in child partition by id DESC)
 *   - SELECT parent's tail version_hash as predecessor
 *   - INSERT sub_scope_resolved into the parent partition with pgcrypto digest()
 *
 * sub_scope_resolved is a Control Plane direct-write — it does NOT go through
 * occWrite, the bus enum, or any Worker path. ADR 12 EVENT_TYPES enum is unchanged.
 *
 * @param pool          Regular read/write pool (not DDL pool)
 * @param childScopeId  The scope that just closed
 * @param triggerTaskId The parent's task_spawned entity_id (carried from createSubScope caller)
 *
 * @see ADR 23 §3 — 三步火炬传递 (three-step torch relay)
 * @see ADR 12 — sub_scope_resolved bypasses EVENT_TYPES enum
 */
export async function resolveSubScope(
  pool: Pool,
  childScopeId: string,
  triggerTaskId: string,
): Promise<void> {
  // Step 1: find parent
  const lineageResult = await pool.query<{ parent_scope_id: string | null }>(
    `SELECT parent_scope_id FROM scope_lineage WHERE scope_id = $1`,
    [childScopeId],
  );
  const parentScopeId = lineageResult.rows[0]?.parent_scope_id ?? null;
  if (!parentScopeId) {
    // Root scope — no propagation
    return;
  }

  // Step 2: read child's final version_hash (tail of child partition by id DESC)
  const childTailResult = await pool.query<{ version_hash: string }>(
    `SELECT version_hash FROM execution_event_log
     WHERE scope_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [childScopeId],
  );
  const childFinalVersionHash = childTailResult.rows[0]?.version_hash ?? ZERO_HASH;

  // Step 3: direct-write sub_scope_resolved to parent partition
  // Mirrors watchdog.ts context_oom_throttled pattern exactly:
  //   predecessor_hash = parent's tail version_hash (ORDER BY id DESC LIMIT 1)
  //   version_hash = pgcrypto digest() in SQL (never computed in TypeScript — ADR 02)
  const entityId = randomUUID();
  const payload = canonicalJson({
    child_scope_id: childScopeId,
    trigger_task_id: triggerTaskId,
    child_final_version_hash: childFinalVersionHash,
    parent_scope_id: parentScopeId,
  });

  await pool.query(
    `INSERT INTO execution_event_log
       (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
     SELECT
       $1::uuid,
       $2::uuid,
       'sub_scope_resolved',
       version_hash,
       encode(
         digest(
           $1::text || '|' || $2::text || '|' || version_hash
             || '|sub_scope_resolved|' || $3,
           'sha256'
         ),
         'hex'
       ),
       $3,
       'pending_scheduling'
     FROM execution_event_log
     WHERE scope_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [parentScopeId, entityId, payload],
  );
}
