/**
 * OCC Writable CTE SQL templates for the Graph-Native Agent Runtime.
 *
 * Two variants:
 *  - OCC_WRITE_SQL: first-writer-wins OCC with atomic causal inversion (ADR 11, ADR 40)
 *  - OCC_WRITE_DO_NOTHING_SQL: idempotent re-delivery via ON CONFLICT DO NOTHING (REQ-18, ADR 32 D-5)
 *
 * Parameters for OCC_WRITE_SQL:
 *   $1 scope_id             — UUID (cast to ::uuid inside SQL)
 *   $2 entity_id            — UUID (cast to ::uuid inside SQL)
 *   $3 predecessor_hash     — TEXT — the slot being claimed (ZERO_HASH for root nodes)
 *   $4 canonical_json_text  — TEXT — pre-serialized BTreeMap-sorted payload (never ::jsonb)
 *   $5 event_type           — TEXT — 'task_spawned' or 'memory_updated' (agent-submitted)
 *
 * Parameters for OCC_WRITE_DO_NOTHING_SQL:
 *   $1–$4 same as above. event_type hardcoded 'memory_updated' (Worker result writes only).
 *
 * CRITICAL INVARIANTS (ADR 02):
 *  - payload is stored as $4::text — NEVER ::jsonb
 *  - version_hash is computed by pgcrypto digest() inside this CTE — application NEVER computes it
 *  - Hash formula: scope_id|entity_id|predecessor_hash|event_type|canonical_json_text
 *  - event_type in the hash is the actual submitted type ($5), NOT a normalised constant
 *
 * Pitfall 5 avoidance: uses COLUMN-LIST form `ON CONFLICT (predecessor_hash, scope_id) DO UPDATE`.
 * INSERT targets the per-scope partition directly (not the parent table) because PostgreSQL
 * requires the unique constraint to exist on the table being inserted into for ON CONFLICT
 * column-list resolution. Use partitionTable(scopeId) to get the target table name.
 * @see docs/ADR_v4.md §ADR 11
 * @see docs/adr/0042-adr40-task-spawned-first-class-event-type.md
 */

/** Compute the partition table name for a given scope UUID. */
export function partitionTable(scopeId: string): string {
  return `execution_event_log_scope_${scopeId.replace(/-/g, '')}`;
}

/**
 * OCC Writable CTE — first-writer-wins with atomic causal inversion.
 *
 * First writer: inserts with event_type=$5 (agent-submitted), returns occ_result='won'.
 * Second writer: ON CONFLICT triggers DO UPDATE that:
 *   1. Sets event_type='conflict_detected'
 *   2. Rewrites predecessor_hash to point at the winner's version_hash (causal inversion)
 *   3. Recomputes version_hash with event_type='conflict_detected' and the SAME canonical_json_text
 *   4. Stores payload=$4::text
 *   Returns occ_result='demoted'.
 *
 * The winner may be either 'task_spawned' or 'memory_updated'. The DO UPDATE subquery
 * finds the winner by excluding 'conflict_detected' rows at the contested slot.
 *
 * The causal inversion is atomic — no application callback, no ::jsonb conversion.
 * @see ADR 11, ADR 02, ADR 40
 */
export function OCC_WRITE_SQL(partition: string): string { return `
WITH attempt AS (
  INSERT INTO ${partition} (
    scope_id,
    entity_id,
    event_type,
    predecessor_hash,
    version_hash,
    payload,
    created_at
  )
  VALUES (
    $1::uuid,
    $2::uuid,
    $5::text,
    $3::text,
    encode(
      digest(
        $1::text || '|' || $2::text || '|' || $3::text || '|' || $5::text || '|' || $4::text,
        'sha256'
      ),
      'hex'
    ),
    $4::text,
    NOW()
  )
  ON CONFLICT (predecessor_hash, scope_id) DO UPDATE SET
    event_type       = 'conflict_detected',
    predecessor_hash = (
      SELECT version_hash
      FROM execution_event_log
      WHERE predecessor_hash = $3::text
        AND scope_id = $1::uuid
        AND event_type NOT IN ('conflict_detected')
      ORDER BY created_at DESC
      LIMIT 1
    ),
    version_hash     = encode(
      digest(
        $1::text || '|' || $2::text
          || '|' || (
            SELECT version_hash
            FROM execution_event_log
            WHERE predecessor_hash = $3::text
              AND scope_id = $1::uuid
              AND event_type NOT IN ('conflict_detected')
            ORDER BY created_at DESC
            LIMIT 1
          )
          || '|conflict_detected|' || $4::text,
        'sha256'
      ),
      'hex'
    ),
    payload          = $4::text,
    created_at       = NOW()
  RETURNING event_type, version_hash
)
SELECT
  event_type,
  version_hash,
  CASE event_type
    WHEN 'conflict_detected' THEN 'demoted'
    ELSE 'won'
  END AS occ_result
FROM attempt;
`; }

/**
 * Idempotent re-delivery variant — ON CONFLICT DO NOTHING on (scope_id, entity_id, version_hash).
 *
 * Used by Workers after tool-result writes per ADR 36 D-9: at-least-once re-delivery is
 * transparent — a duplicate insert with the same version_hash silently affects 0 rows.
 *
 * event_type is hardcoded 'memory_updated': Worker result writes are always semantic
 * memory updates, regardless of the triggering event's type. This variant is NOT used
 * for external agent submissions (which use OCC_WRITE_SQL with $5 event_type).
 *
 * Returns 0 or 1 rows. If 0 rows returned the insert was a no-op (duplicate).
 * @see ADR 32 D-5, REQ-18
 */
export function OCC_WRITE_DO_NOTHING_SQL(partition: string): string { return `
WITH attempt AS (
  INSERT INTO ${partition} (
    scope_id,
    entity_id,
    event_type,
    predecessor_hash,
    version_hash,
    payload,
    created_at
  )
  VALUES (
    $1::uuid,
    $2::uuid,
    'memory_updated',
    $3::text,
    encode(
      digest(
        $1::text || '|' || $2::text || '|' || $3::text || '|memory_updated|' || $4::text,
        'sha256'
      ),
      'hex'
    ),
    $4::text,
    NOW()
  )
  ON CONFLICT (scope_id, entity_id, version_hash) DO NOTHING
  RETURNING event_type, version_hash
)
SELECT
  event_type,
  version_hash,
  'won' AS occ_result
FROM attempt;
`; }
