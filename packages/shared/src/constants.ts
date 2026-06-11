/**
 * Shared constants for the Graph-Native Agent Runtime.
 * All values are LOCKED per ADR references.
 */

import { CANONICAL_EVENT_TYPES, type CanonicalEventType } from './types.js';

/**
 * Sentinel predecessor_hash for the graph root (plan_created event).
 * 64 zeros — used as the first predecessor_hash in a new Scope chain.
 * @see ADR 02
 */
export const ZERO_HASH = '0'.repeat(64) as string;

/**
 * Five canonical event types. Any other type is rejected at bus level.
 * Derived from CANONICAL_EVENT_TYPES in @graph/types — single source of truth.
 * @see ADR 12
 */
export const EVENT_TYPES = Object.values(CANONICAL_EVENT_TYPES) as CanonicalEventType[];

/**
 * Maximum number of concurrent Worker slots in the iii execution pool.
 * iii engine FIFO only — all priority logic lives in PostgreSQL + Frontier Scheduler Worker.
 * @see ADR 31, ADR 29
 */
export const MAX_PARALLELISM = 4;

/**
 * Maximum nesting depth for child Scopes.
 * Phase 1: in-process sub-agent branching only.
 * @see ADR 34 D-7
 */
export const MAX_CHILD_SCOPE_DEPTH = 3;

/**
 * Minimum number of completed Scopes required before the Pattern Discovery Worker
 * will execute its analysis. Guards against insufficient corpus.
 * @see ADR 37 D-10
 */
export const MIN_CORPUS_THRESHOLD = 10;

/**
 * Staleness threshold (seconds) for agent_registry heartbeat eviction.
 * Agents whose last_heartbeat is older than this value are excluded from
 * FrontierScheduler skill-matching dispatch (Plan 03-03).
 *
 * Value 60s is at Claude's discretion per CONTEXT.md §"Claude's Discretion".
 * Referenced in DESIGN.md §3.2 and FrontierScheduler skill-match query:
 *   WHERE status = 'active' AND last_heartbeat > NOW() - INTERVAL '60 seconds'
 *
 * @see ADR 37 — Pattern Discovery Schedule (D-10 cron isolation)
 * @see .harness/phases/side-branch/DESIGN.md §3.2 — agent_registry schema
 */
export const AGENT_HEARTBEAT_TTL_S = 60;

/**
 * iii topic for sub_scope_resolved events.
 * Pulse-Fetch routes this event type to its own topic (not the frontier topic).
 * SubScopeResultWorker registers a durable:subscriber on this topic.
 * @see ADR 23 §4
 */
export const SUB_SCOPE_TOPIC = 'graph::scope::sub_scope_resolved';
