/**
 * Graph handles — Worker-facing (GraphHandle) and Tool-facing (ReadOnlyGraphHandle).
 *
 * Workers receive GraphHandle (has write()). Tools receive ReadOnlyGraphHandle
 * (write() absent from interface → TypeScript compile error if a Tool calls it).
 *
 * Pool-backed adapters: PoolGraphHandle, PoolReadOnlyGraphHandle.
 * Test double: StubGraphHandle — no pg dependency; tracks write() calls.
 *
 * @see ADR 35 — Worker/Tool boundary enforcement
 * @see ADR 33 — Scope identity boundary (UUID orthogonality)
 * @see ADR 29 — Worker/Tool/Knowledge/Connector 4-element boundary
 */

import type { Pool } from 'pg';
import type { GraphWriteEvent, WriteResult } from '@shared/types.js';
import { OCC_WRITE_SQL, partitionTable } from '@shared/sql/occ-writable-cte.sql.js';
import { PoolTrailReader, StubTrailReader } from './trail-reader.js';
import type { TrailReader } from './trail-reader.js';

// ── Worker-facing handle ──────────────────────────────────────────────────────

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
 * Pool-backed GraphHandle for production use.
 * Inherits TrailReader methods from PoolTrailReader; adds write() and scopeId.
 */
export class PoolGraphHandle extends PoolTrailReader implements GraphHandle {
  readonly scopeId: string;
  private readonly _pool: Pool;

  constructor(scopeId: string, pool: Pool) {
    super(pool);
    this.scopeId = scopeId;
    this._pool = pool;
  }

  async write(event: GraphWriteEvent): Promise<WriteResult> {
    const { scope_id, entity_id, event_type, predecessor_hash, canonical_json_text } = event;
    const result = await this._pool.query(
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

// ── Tool-facing handle ────────────────────────────────────────────────────────

/**
 * Read-only graph handle — the ONLY interface Tools receive.
 * Extends TrailReader: Tools access domain reads via named methods, not raw SQL.
 * write() is deliberately ABSENT: calling ctx.graph.write() from a Tool
 * is a TypeScript compile error.
 */
export interface ReadOnlyGraphHandle extends TrailReader {
  /** The Scope UUID. Business-task identity; NEVER mutated by context-size operations. */
  readonly scopeId: string;
}

/**
 * Thrown when code attempts to call write() on a ReadOnlyGraphHandle
 * via an `any` cast or other type-system bypass.
 */
export class SecurityException extends Error {
  constructor(message = 'SecurityException: write() is forbidden on ReadOnlyGraphHandle') {
    super(message);
    this.name = 'SecurityException';
  }
}

/**
 * Pool-backed ReadOnlyGraphHandle for production use.
 * Inherits TrailReader methods from PoolTrailReader; adds scopeId.
 *
 * Provides a non-interface write() that throws SecurityException — runtime
 * defense against `any`-cast bypasses of the TypeScript type system.
 */
export class PoolReadOnlyGraphHandle extends PoolTrailReader implements ReadOnlyGraphHandle {
  readonly scopeId: string;

  constructor(scopeId: string, pool: Pool) {
    super(pool);
    this.scopeId = scopeId;
  }

  /** NOT part of ReadOnlyGraphHandle. Throws SecurityException unconditionally. */
  write(_event: unknown): never {
    throw new SecurityException();
  }
}

// ── Test double ───────────────────────────────────────────────────────────────

/**
 * Test double — no pg dependency; safe empty defaults; tracks write() calls.
 * Use in Worker unit tests instead of creating inline mock objects.
 */
export class StubGraphHandle extends StubTrailReader implements GraphHandle {
  readonly scopeId: string;
  readonly calls = { write: [] as GraphWriteEvent[] };

  constructor(scopeId = 'stub-scope') {
    super();
    this.scopeId = scopeId;
  }

  async write(event: GraphWriteEvent): Promise<WriteResult> {
    this.calls.write.push(event);
    return { version_hash: 'stub-hash', event_type: event.event_type, occ_result: 'won' };
  }
}
