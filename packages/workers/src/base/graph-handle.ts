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

import type { Pool, QueryResultRow } from 'pg';
import type { GraphWriteEvent, WriteResult } from '@shared/types.js';
import { OCC_WRITE_SQL, partitionTable } from '@shared/sql/occ-writable-cte.sql.js';

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
 */
export class GraphHandleImpl implements GraphHandle {
  readonly scopeId: string;
  private readonly pool: Pool;

  constructor(scopeId: string, pool: Pool) {
    this.scopeId = scopeId;
    this.pool = pool;
  }

  async write(event: GraphWriteEvent): Promise<WriteResult> {
    const { scope_id, entity_id, event_type, predecessor_hash, canonical_json_text } = event;
    const result = await this.pool.query(
      OCC_WRITE_SQL(partitionTable(scope_id)),
      [scope_id, entity_id, predecessor_hash, canonical_json_text, event_type],
    );
    const row = result.rows[0];
    return {
      version_hash: row.version_hash as string,
      event_type: row.event_type as WriteResult['event_type'],
      occ_result: row.occ_result as 'won' | 'demoted',
    };
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query<T>(sql, params);
    return result.rows;
  }
}
