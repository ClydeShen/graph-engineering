/**
 * Shared TypeScript type definitions for the Graph-Native Agent Runtime.
 */

import type { EVENT_TYPES } from './constants.js';

/**
 * A canonical event type from the five locked event types.
 * @see ADR 12
 */
export type CanonicalEventType = (typeof EVENT_TYPES)[number];

/**
 * A single row from execution_event_log as returned by queries.
 * payload is stored as TEXT (canonical JSON) — never JSONB per ADR 02 invariant.
 */
export interface EventLogNode {
  id: string;
  scope_id: string;
  entity_id: string;
  event_type: CanonicalEventType;
  predecessor_hash: string;
  version_hash: string;
  /** Canonical JSON text — TEXT column, never JSONB. Deserialize before use. */
  payload: string;
  status: 'pending_scheduling' | 'pending_dispatch' | 'processing' | 'terminated' | 'archived' | 'suspended';
  base_priority: number;
  unlocks_count: number;
  spawned_by: string | null;
  last_active_at: Date | null;
  created_at: Date;
}

/**
 * Input to a graph write operation.
 * canonical_json_text is pre-computed by hashablePayload() before passing to the DB.
 */
export interface GraphWriteEvent {
  scope_id: string;
  entity_id: string;
  event_type: CanonicalEventType;
  predecessor_hash: string;
  /** Pre-serialized canonical JSON text — sent to PostgreSQL as TEXT literal. */
  canonical_json_text: string;
}

/**
 * Result of an OCC Writable CTE write operation.
 * 'won' = first writer claimed the predecessor_hash slot.
 * 'demoted' = second writer lost the race; its event was rewritten as conflict_detected.
 * @see ADR 11
 */
export interface WriteResult {
  version_hash: string;
  event_type: CanonicalEventType;
  occ_result: 'won' | 'demoted';
}
