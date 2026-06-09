/**
 * ReadOnlyGraphHandle — restricted graph access for Tools.
 *
 * The interface does NOT declare write(). Any Tool that attempts to call
 * ctx.graph.write() produces a TypeScript compile error (tsc --noEmit fails).
 *
 * The concrete class ReadOnlyGraphHandleImpl includes a non-interface write()
 * method that throws SecurityException — providing a runtime guard against
 * `any`-cast bypasses.
 *
 * Scope UUID held by a ReadOnlyGraphHandle is the BUSINESS TASK IDENTITY.
 * It is NEVER rotated on context overflow — completely orthogonal to context
 * window size. (ADR 33 / REQ-23)
 *
 * @see ADR 35 — Worker/Tool capability boundary enforcement
 * @see ADR 33 — Scope identity orthogonality (REQ-23)
 */

import type { Pool } from 'pg';
import { PoolTrailReader } from './trail-reader.js';
import type { TrailReader } from './trail-reader.js';

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
 * Runtime guard: thrown when code attempts to call write() on a ReadOnlyGraphHandle
 * via an `any` cast or other type-system bypass.
 */
export class SecurityException extends Error {
  constructor(message = 'SecurityException: write() is forbidden on ReadOnlyGraphHandle') {
    super(message);
    this.name = 'SecurityException';
  }
}

/**
 * Concrete implementation of ReadOnlyGraphHandle.
 * Extends PoolTrailReader: inherits all TrailReader methods.
 *
 * Provides a non-interface write() method that throws SecurityException — runtime
 * defense against `any`-cast bypasses.
 */
export class ReadOnlyGraphHandleImpl extends PoolTrailReader implements ReadOnlyGraphHandle {
  readonly scopeId: string;

  constructor(scopeId: string, pool: Pool) {
    super(pool);
    this.scopeId = scopeId;
  }

  /**
   * NOT part of the ReadOnlyGraphHandle interface.
   * Throws SecurityException unconditionally.
   * Guards against `any`-cast bypasses at runtime.
   */
  write(_event: unknown): never {
    throw new SecurityException();
  }
}
