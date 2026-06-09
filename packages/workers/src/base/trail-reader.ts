/**
 * TrailReader — domain read seam over the Trail Mesh and Episodic Memory.
 *
 * The single interface through which all domain reads flow:
 *   Workers during execution (injected at construction)
 *   Tools in their restricted execution context (no write access)
 *
 * Two adapters justify the seam:
 *   PoolTrailReader — production, backed by pg.Pool (stateless, shared across scopes)
 *   StubTrailReader — test double, returns safe empty defaults
 *
 * @see ADR 35 — Worker/Tool capability boundary
 * @see ADR 29 — Worker/Tool/Knowledge/Connector boundary
 */

import type { Pool } from 'pg';
import { ZERO_HASH } from '@shared/constants.js';
import type { EventLogNode } from '@shared/types.js';

export interface TrailReaderOptions {
  /** Maximum number of records to return. Default: 100. */
  limit?: number;
  /** Only return records created within the last N hours. Omit for no time filter. */
  sinceHours?: number;
}

/**
 * Read-only domain interface over the Trail Mesh (execution_event_log)
 * and Episodic Memory tier.
 *
 * Methods take scopeId per-call — the reader is stateless and shared across scopes.
 */
export interface TrailReader {
  /**
   * Fetch the Version at a specific hash from the Trail Mesh.
   * Returns null if no matching Version exists in the given scope.
   */
  getVersionByHash(scopeId: string, versionHash: string): Promise<EventLogNode | null>;

  /**
   * Return the version_hash of the most-recently written event in a scope.
   * Returns ZERO_HASH when the scope has no events.
   */
  getTailVersionHash(scopeId: string): Promise<string>;

  /**
   * Return Episodic Memory content strings for a scope, oldest-first.
   * Options control the result window; defaults to 100 records, no time filter.
   */
  getEpisodicRecords(scopeId: string, options?: TrailReaderOptions): Promise<string[]>;
}

/**
 * Production adapter — PoolTrailReader → pg.Pool.
 * Stateless: one instance serves all scopes; scopeId is passed per call.
 */
export class PoolTrailReader implements TrailReader {
  constructor(private readonly pool: Pool) {}

  async getVersionByHash(scopeId: string, versionHash: string): Promise<EventLogNode | null> {
    const { rows } = await this.pool.query<EventLogNode>(
      `SELECT * FROM execution_event_log
       WHERE scope_id = $1 AND version_hash = $2
       LIMIT 1`,
      [scopeId, versionHash],
    );
    return rows[0] ?? null;
  }

  async getTailVersionHash(scopeId: string): Promise<string> {
    const { rows } = await this.pool.query<{ version_hash: string }>(
      `SELECT version_hash FROM execution_event_log
       WHERE scope_id = $1
       ORDER BY id DESC
       LIMIT 1`,
      [scopeId],
    );
    return rows[0]?.version_hash ?? ZERO_HASH;
  }

  async getEpisodicRecords(scopeId: string, opts?: TrailReaderOptions): Promise<string[]> {
    const { rows } = await this.pool.query<{ content: string }>(
      `SELECT content FROM episodic_memory
       WHERE scope_id = $1
         AND ($2::int IS NULL OR created_at > NOW() - ($2 || ' hours')::interval)
       ORDER BY created_at ASC
       LIMIT $3`,
      [scopeId, opts?.sinceHours ?? null, opts?.limit ?? 100],
    );
    return rows.map((r) => r.content);
  }
}

/**
 * Test double — all methods return safe empty defaults.
 * Override individual methods with vi.fn() / vi.spyOn() as needed in specific tests.
 */
export class StubTrailReader implements TrailReader {
  async getVersionByHash(_scopeId: string, _versionHash: string): Promise<EventLogNode | null> {
    return null;
  }
  async getTailVersionHash(_scopeId: string): Promise<string> {
    return ZERO_HASH;
  }
  async getEpisodicRecords(_scopeId: string, _opts?: TrailReaderOptions): Promise<string[]> {
    return [];
  }
}
