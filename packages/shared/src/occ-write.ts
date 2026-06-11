/**
 * occWrite() — OCC Writable CTE helper for the Graph-Native Agent Runtime.
 *
 * The application layer prepares canonical_json_text (via hashablePayload) and passes it
 * to the Writable CTE as a TEXT parameter. The DB computes version_hash via pgcrypto.
 * The application NEVER computes the hash itself (ADR 02 invariant).
 *
 * @see packages/shared/src/sql/occ-writable-cte.sql.ts
 * @see docs/ADR_v4.md §ADR 02, §ADR 11
 */

import type { Pool } from 'pg';
import { hashablePayload } from './canonical-json.js';
import { OCC_WRITE_SQL, OCC_WRITE_DO_NOTHING_SQL, partitionTable } from './sql/occ-writable-cte.sql.js';
import type { WriteResult } from './types.js';

/**
 * Arguments for an OCC write operation.
 */
export interface OccWriteArgs {
  /** Scope UUID — identifies the partition (LIST partition key). */
  scopeId: string;
  /** Entity UUID — stable business object identity across versions. */
  entityId: string;
  /** SHA-256 hash of the predecessor version (ZERO_HASH for root nodes). */
  predecessorHash: string;
  /**
   * Raw payload object. Will be stripped of _meta and schema_version, then
   * serialized to canonical JSON text before being passed to PostgreSQL.
   * The application NEVER computes the version_hash — that is done by pgcrypto
   * inside the Writable CTE.
   */
  payload: Record<string, unknown>;
  /**
   * Agent-submitted semantic event type. Stored as a first-class column value
   * and included in the version_hash formula. Must be 'task_spawned' or
   * 'memory_updated' for external agent writes. (ADR 40)
   */
  eventType: 'task_spawned' | 'memory_updated';
}

/**
 * Execute the OCC Writable CTE against the given pool.
 *
 * The helper:
 * 1. Strips _meta and schema_version from payload via hashablePayload()
 * 2. Passes the resulting canonical JSON TEXT as $4 to OCC_WRITE_SQL
 * 3. Returns the version_hash and occ_result from the DB
 *
 * Returns:
 *   occ_result='won'     → first writer claimed the predecessor_hash slot
 *   occ_result='demoted' → second writer lost; its event was rewritten as conflict_detected
 *
 * Note: This function does NOT call crypto.createHash(). Hash computation is
 * exclusively performed by pgcrypto digest() inside the Writable CTE (ADR 02).
 */
export async function occWrite(
  pool: Pool,
  args: OccWriteArgs
): Promise<WriteResult> {
  const { scopeId, entityId, predecessorHash, payload, eventType } = args;

  // Prepare canonical text — strips _meta + schema_version, sorts keys (BTreeMap equiv.)
  const canonicalText = hashablePayload(payload);

  const result = await pool.query<{
    id: string | null;
    event_type: string;
    version_hash: string;
    occ_result: string;
  }>(OCC_WRITE_SQL(partitionTable(scopeId)), [scopeId, entityId, predecessorHash, canonicalText, eventType]);

  const row = result.rows[0];
  const rowId = row.id ? Number(row.id) : null;
  if (rowId) {
    void pool.query(
      "SELECT pg_notify('graph_event_ready', $1::text)",
      [JSON.stringify({ id: rowId })],
    ).catch(() => {});
  }
  return {
    version_hash: row.version_hash,
    event_type: row.event_type as WriteResult['event_type'],
    occ_result: row.occ_result as WriteResult['occ_result'],
  };
}

/**
 * Execute the idempotent DO NOTHING variant of the OCC write.
 *
 * Used for at-least-once re-delivery safety: if a row with the same
 * (scope_id, entity_id, version_hash) already exists, the insert is silently
 * dropped (0 rows returned). This is the correct path for Worker tool-result
 * writes per ADR 36 D-9 and ADR 32 D-5.
 *
 * Returns null if the insert was a no-op (duplicate). Returns WriteResult if inserted.
 */
export async function occWriteIdempotent(
  pool: Pool,
  args: Omit<OccWriteArgs, 'eventType'>
): Promise<WriteResult | null> {
  const { scopeId, entityId, predecessorHash, payload } = args;
  const canonicalText = hashablePayload(payload);

  const result = await pool.query<{
    id: string | null;
    event_type: string;
    version_hash: string;
    occ_result: string;
  }>(OCC_WRITE_DO_NOTHING_SQL(partitionTable(scopeId)), [scopeId, entityId, predecessorHash, canonicalText]);

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const rowId = row.id ? Number(row.id) : null;
  if (rowId) {
    void pool.query(
      "SELECT pg_notify('graph_event_ready', $1::text)",
      [JSON.stringify({ id: rowId })],
    ).catch(() => {});
  }
  return {
    version_hash: row.version_hash,
    event_type: row.event_type as WriteResult['event_type'],
    occ_result: row.occ_result as WriteResult['occ_result'],
  };
}
