/**
 * OCC Writable CTE SQL templates for the Graph-Native Agent Runtime.
 *
 * Two variants:
 *  - OCC_WRITE_SQL: first-writer-wins OCC with atomic causal inversion (ADR 11)
 *  - OCC_WRITE_DO_NOTHING_SQL: idempotent re-delivery via ON CONFLICT DO NOTHING (REQ-18, ADR 32 D-5)
 *
 * Parameters (both variants):
 *   $1 scope_id             — UUID (cast to ::uuid inside SQL)
 *   $2 entity_id            — UUID (cast to ::uuid inside SQL)
 *   $3 predecessor_hash     — TEXT — the slot being claimed (ZERO_HASH for root nodes)
 *   $4 canonical_json_text  — TEXT — pre-serialized BTreeMap-sorted payload (never ::jsonb)
 *
 * CRITICAL INVARIANTS (ADR 02):
 *  - payload is stored as $4::text — NEVER ::jsonb
 *  - version_hash is computed by pgcrypto digest() inside this CTE — application NEVER computes it
 *  - Hash formula: scope_id|entity_id|predecessor_hash|event_type|canonical_json_text
 *
 * Pitfall 5 avoidance: uses COLUMN-LIST form `ON CONFLICT (predecessor_hash, scope_id) DO UPDATE`
 * NOT `ON CONFLICT ON CONSTRAINT <name>` — column-list form resolves to the correct
 * per-partition constraint automatically without requiring the constraint name.
 * @see .planning/phases/01-core-graph-engine/01-RESEARCH.md Pitfall 5
 * @see docs/ADR_v4.md §ADR 11
 */

/**
 * OCC Writable CTE — first-writer-wins with atomic causal inversion.
 *
 * First writer: inserts with event_type='memory_updated', returns occ_result='won'.
 * Second writer: ON CONFLICT triggers DO UPDATE that:
 *   1. Sets event_type='conflict_detected'
 *   2. Rewrites predecessor_hash to point at the winner's version_hash (causal inversion)
 *   3. Recomputes version_hash with event_type='conflict_detected' and the SAME canonical_json_text
 *   4. Stores payload=$4::text
 *   Returns occ_result='demoted'.
 *
 * The causal inversion is atomic — no application callback, no ::jsonb conversion.
 * @see ADR 11, ADR 02
 */
export const OCC_WRITE_SQL = `
WITH attempt AS (
  INSERT INTO execution_event_log (
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
  ON CONFLICT (predecessor_hash, scope_id) DO UPDATE SET
    event_type       = 'conflict_detected',
    predecessor_hash = (
      SELECT version_hash
      FROM execution_event_log
      WHERE predecessor_hash = $3::text
        AND scope_id = $1::uuid
        AND event_type = 'memory_updated'
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
              AND event_type = 'memory_updated'
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
    WHEN 'memory_updated'    THEN 'won'
    WHEN 'conflict_detected' THEN 'demoted'
  END AS occ_result
FROM attempt;
`;

/**
 * Idempotent re-delivery variant — ON CONFLICT DO NOTHING on (scope_id, entity_id, version_hash).
 *
 * Used by Workers after tool-result writes per ADR 36 D-9: at-least-once re-delivery is
 * transparent — a duplicate insert with the same version_hash silently affects 0 rows.
 *
 * Returns 0 or 1 rows. If 0 rows returned the insert was a no-op (duplicate).
 * @see ADR 32 D-5, REQ-18
 */
export const OCC_WRITE_DO_NOTHING_SQL = `
WITH attempt AS (
  INSERT INTO execution_event_log (
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
`;
