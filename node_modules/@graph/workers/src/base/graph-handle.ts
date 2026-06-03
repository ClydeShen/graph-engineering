/**
 * GraphHandle — full read/write access for Workers.
 *
 * Workers receive a GraphHandle (has write()). Tools receive ReadOnlyGraphHandle
 * (write() absent from interface → TypeScript compile error if a Tool calls it).
 *
 * Scope UUID held by a GraphHandle is the BUSINESS TASK IDENTITY.
 * It is NEVER rotated on context overflow — context-window size and Scope UUID
 * are orthogonal axes. (ADR 33 / REQ-23)
 *
 * @see ADR 35 — Worker/Tool boundary enforcement
 * @see ADR 33 — Scope identity boundary (UUID orthogonality)
 */

import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { GraphWriteEvent, WriteResult } from '@shared/types.js';

/**
 * Full read/write graph handle — held exclusively by Workers.
 * Tools MUST NOT receive this interface; they receive ReadOnlyGraphHandle.
 */
export interface GraphHandle {
  /** The Scope UUID. Business-task identity; NEVER mutated by context-size operations. */
  readonly scopeId: string;

  /**
   * Append an event to the execution_event_log via OCC Writable CTE.
   * Returns WriteResult with occ_result 'won' | 'demoted'.
   *
   * MUST NOT be called during the Processing lifecycle phase.
   * @see ADR 27, ADR 36
   */
  write(event: GraphWriteEvent): Promise<WriteResult>;

  /** Execute a read-only SQL query against the graph. */
  query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Concrete GraphHandle backed by a pg Pool.
 * Delegates write() to the OCC Writable CTE (occWrite).
 */
export class GraphHandleImpl implements GraphHandle {
  readonly scopeId: string;
  private readonly pool: Pool;

  constructor(scopeId: string, pool: Pool) {
    this.scopeId = scopeId;
    this.pool = pool;
  }

  async write(event: GraphWriteEvent): Promise<WriteResult> {
    return occWrite(this.pool, event);
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }
}

/**
 * OCC Writable CTE — executes the append-only insert with SHA-256 hash chain.
 *
 * Uses pgcrypto.digest() inside the CTE. First writer wins (occ_result='won').
 * Second writer's event is rewritten as conflict_detected (occ_result='demoted').
 * No application callback or ::jsonb conversion. (ADR 11, ADR 02)
 */
export async function occWrite(pool: Pool | PoolClient, event: GraphWriteEvent): Promise<WriteResult> {
  // Writable CTE: compute version_hash via pgcrypto, insert, handle OCC conflict.
  // The canonical_json_text is already pre-serialized by the caller (ADR 02).
  const sql = `
    WITH input AS (
      SELECT
        $1::uuid            AS scope_id,
        $2::uuid            AS entity_id,
        $3::text            AS event_type,
        $4::text            AS predecessor_hash,
        $5::text            AS canonical_json_text
    ),
    computed AS (
      SELECT
        scope_id, entity_id, event_type, predecessor_hash, canonical_json_text,
        encode(
          pgcrypto.digest(
            scope_id::text || '|' || entity_id::text || '|' ||
            predecessor_hash || '|' || event_type || '|' || canonical_json_text,
            'sha256'
          ),
          'hex'
        ) AS version_hash
      FROM input
    ),
    inserted AS (
      INSERT INTO execution_event_log
        (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
      SELECT
        scope_id, entity_id, event_type, predecessor_hash, version_hash,
        canonical_json_text, 'pending_scheduling'
      FROM computed
      ON CONFLICT (predecessor_hash, scope_id) DO NOTHING
      RETURNING version_hash, event_type
    )
    SELECT
      COALESCE(i.version_hash, c.version_hash) AS version_hash,
      CASE WHEN i.version_hash IS NOT NULL THEN 'won' ELSE 'demoted' END AS occ_result,
      c.event_type
    FROM computed c
    LEFT JOIN inserted i ON true
  `;

  const { scope_id, entity_id, event_type, predecessor_hash, canonical_json_text } = event;
  const result = await (pool as Pool).query(sql, [
    scope_id, entity_id, event_type, predecessor_hash, canonical_json_text,
  ]);

  const row = result.rows[0];
  return {
    version_hash: row.version_hash as string,
    event_type: row.event_type as WriteResult['event_type'],
    occ_result: row.occ_result as 'won' | 'demoted',
  };
}
