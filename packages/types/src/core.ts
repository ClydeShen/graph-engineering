/**
 * Core graph engine entity types — Memex vocabulary.
 *
 * This module is a leaf: it imports no @graph/* packages.
 * Resurrected (Phase 11) from the dead-code sprint removal — now consumed by
 * @graph/types/shell and the MemexShell clients.
 *
 * @see CLAUDE.md — Key Domain Terms
 */

/**
 * Entity — logical object with stable UUID; addressable across all Trails that touched it.
 * (Bush's Memex "Item")
 */
export interface Entity {
  id: string;
  kind: string;
  created_at: Date;
}

/**
 * Snapshot — immutable state of an Entity at a point in time; identified by SHA-256 content hash.
 * (Bush's Memex "Version")
 */
export interface Snapshot {
  version_hash: string;
  entity_id: string;
  /** Canonical JSON text — TEXT column, never JSONB. Deserialize before use. */
  payload: string;
  created_at: Date;
}

/**
 * HyperEdge — directed immutable Association link (source, target, event_type, version_hash, timestamp).
 * Atomic unit of connection in the Trail Mesh.
 * (Bush's Memex "Association")
 */
export interface HyperEdge {
  source: string;
  target: string;
  event_type: string;
  version_hash: string;
  timestamp: Date;
}

/**
 * Scope — execution boundary that contains a Trail; the unit of causal isolation.
 * A Scope is the container for one agent execution session.
 */
export interface Scope {
  id: string;
  intent: string;
  status: string;
  created_at: Date;
}

/**
 * Trail — full execution record within a Scope, including deviations and conflicts.
 * The raw material for pattern discovery.
 * (Bush's Memex "Trail" / implementation alias: CognitiveTrace)
 */
export interface Trail {
  scope_id: string;
  entity_id: string;
  records: string[];
}

/**
 * Lesson — extracted insight from Crystallization; confidence-weighted,
 * reinforced on an Ebbinghaus schedule.
 */
export interface Lesson {
  fingerprint_id: string;
  content: string;
  /** 0..1, Ebbinghaus-reinforced: confidence += 0.1 * (1 - confidence). */
  confidence: number;
  reinforcement_count: number;
  last_used_at: Date | null;
}

/**
 * Principal trust levels — locked enum shared by Phase 13 (AgentCard routing)
 * and Phase 14 (trust → toolset mapping). Defined here so both phases consume
 * one definition (13/14 interlock, 13-PHASE-SPEC §4).
 */
export const TRUST_LEVELS = {
  untrusted: 'untrusted',
  paired: 'paired',
  trusted: 'trusted',
} as const;

export type TrustLevel = typeof TRUST_LEVELS[keyof typeof TRUST_LEVELS];
