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
 * OCC Writable CTE — first-writer-wins, losers appended as conflict_detected.
 *
 * First writer:  inserts with event_type=$5, returns occ_result='won'.
 * Second+ writer: DO NOTHING on the contested slot, then inserts a NEW
 *   conflict_detected row whose predecessor points at the winner's version_hash
 *   (causal append, not causal inversion). The winner row is never mutated.
 *
 * Three-CTE structure:
 *   attempt        — try the slot; DO NOTHING on conflict
 *   winner         — find the row that holds predecessor_hash=$3 (excluding conflicts)
 *   conflict       — insert conflict_detected after the winner (skipped if attempt won)
 *   demoted_fallback — if two losers race for the conflict slot, the second gets DO NOTHING;
 *                      return a computed version_hash so the application always gets a row
 *
 * @see ADR 11, ADR 02, ADR 40
 */
export function OCC_WRITE_SQL(partition: string): string { return `
WITH
attempt AS (
  INSERT INTO ${partition} (
    scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, created_at
  )
  VALUES (
    $1::uuid, $2::uuid, $5::text, $3::text,
    encode(
      digest($1::text || '|' || $2::text || '|' || $3::text || '|' || $5::text || '|' || $4::text, 'sha256'),
      'hex'
    ),
    $4::text, NOW()
  )
  ON CONFLICT (predecessor_hash, scope_id) DO NOTHING
  RETURNING event_type, version_hash
),
winner AS (
  SELECT version_hash AS wh
  FROM ${partition}
  WHERE predecessor_hash = $3::text
    AND scope_id = $1::uuid
    AND event_type <> 'conflict_detected'
  LIMIT 1
),
conflict AS (
  INSERT INTO ${partition} (
    scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, created_at
  )
  SELECT
    $1::uuid, $2::uuid, 'conflict_detected', wh,
    encode(
      digest($1::text || '|' || $2::text || '|' || wh || '|conflict_detected|' || $4::text, 'sha256'),
      'hex'
    ),
    $4::text, NOW()
  FROM winner
  WHERE NOT EXISTS (SELECT 1 FROM attempt)
  ON CONFLICT (predecessor_hash, scope_id) DO NOTHING
  RETURNING event_type, version_hash
),
demoted_fallback AS (
  SELECT
    'conflict_detected'::text AS event_type,
    encode(
      digest($1::text || '|' || $2::text || '|' || wh || '|conflict_detected|' || $4::text, 'sha256'),
      'hex'
    ) AS version_hash
  FROM winner
  WHERE NOT EXISTS (SELECT 1 FROM attempt)
    AND NOT EXISTS (SELECT 1 FROM conflict)
)
SELECT event_type, version_hash,
  CASE event_type WHEN 'conflict_detected' THEN 'demoted' ELSE 'won' END AS occ_result
FROM attempt
UNION ALL
SELECT event_type, version_hash, 'demoted' AS occ_result FROM conflict
UNION ALL
SELECT event_type, version_hash, 'demoted' AS occ_result FROM demoted_fallback;
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
