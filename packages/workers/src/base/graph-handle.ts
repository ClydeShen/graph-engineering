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

import type { Pool } from 'pg';
import type { GraphWriteEvent, WriteResult } from '@shared/types.js';
import { OCC_WRITE_SQL, partitionTable } from '@shared/sql/occ-writable-cte.sql.js';
import { PoolTrailReader } from './trail-reader.js';
import type { TrailReader } from './trail-reader.js';

/**
 * Full read/write graph handle — held exclusively by Workers.
 * Extends TrailReader: Workers access domain reads via named methods, not raw SQL.
 * Tools MUST NOT receive this interface; they receive ReadOnlyGraphHandle.
 */
export interface GraphHandle extends TrailReader {
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
}

/**
 * Concrete GraphHandle backed by a pg Pool.
 * Inherits TrailReader methods from PoolTrailReader; adds write() and scopeId.
 */
export class GraphHandleImpl extends PoolTrailReader implements GraphHandle {
  readonly scopeId: string;

  constructor(scopeId: string, pool: Pool) {
    super(pool);
    this.scopeId = scopeId;
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
}
