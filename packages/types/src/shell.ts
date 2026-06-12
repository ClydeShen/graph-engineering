/**
 * MemexShell consumption types — Dashboard state, MemexTerminal session, realtime wire shapes.
 *
 * This module is a leaf: it imports no @graph/* packages (only sibling ./core).
 * Pi SDK alignment: MemexTerminal session types extend the Pi SDK official
 * interfaces at the point of use (packages/pi-extension, MemexTerminal) — wire
 * shapes here stay SDK-independent so the Gateway never imports Pi SDK types.
 *
 * @see docs/adr/0053-adr44-realtime-ws-sse-api.md — endpoint contract
 */

import type { Scope } from './core.js';

/**
 * Realtime event types pushed over SSE (/v1/stream) and WS (/ws).
 * Derived from the Phase 08 pipeline hooks + scope lifecycle.
 */
export const REALTIME_EVENT_TYPES = {
  /** A new event row landed in the Trail (pulse: id only — point-query for detail). */
  trail_appended: 'trail_appended',
  scope_created: 'scope_created',
  scope_closed: 'scope_closed',
  /** Phase 08 pipeline hook mirrors. */
  context_assembled: 'context_assembled',
  context_compressed: 'context_compressed',
  llm_called: 'llm_called',
  result_written: 'result_written',
  /** Reserved for gateway-side streaming LLM turns (not emitted in Phase 11). */
  text_delta: 'text_delta',
} as const;

export type RealtimeEventType =
  typeof REALTIME_EVENT_TYPES[keyof typeof REALTIME_EVENT_TYPES];

/**
 * Server-Sent Event (SSE) shape for streaming Trail events to Dashboard/MemexTerminal.
 */
export interface TrailSseEvent {
  type: 'trail_event';
  event_type: RealtimeEventType | string;
  payload: unknown;
  scope_id: string;
  timestamp: string;
}

// ── WS message protocol (/ws) ────────────────────────────────────────────────

/** Client → Gateway: submit an agent event (mirror of POST /v1/scopes/:id/events). */
export interface WsAgentEventMessage {
  type: 'agent_event';
  scope_id: string;
  event: {
    entity_id: string;
    event_type: 'task_spawned' | 'memory_updated';
    predecessor_hash: string;
    payload: unknown;
  };
  /** Echoed back in the matching turn_result for request/response correlation. */
  request_id?: string;
}

/** Client → Gateway: subscribe to trail broadcasts (optionally scoped). */
export interface WsSubscribeMessage {
  type: 'subscribe';
  scope_id?: string;
}

/**
 * Client → Gateway: one conversation turn (ADR 54). The gateway owns
 * predecessor tracking and runs the conversation core; reply text streams
 * back as trail_event text_delta frames, then a turn_result closes the turn.
 */
export interface WsUserMessage {
  type: 'user_message';
  scope_id: string;
  text: string;
  request_id?: string;
}

export type WsClientMessage = WsAgentEventMessage | WsSubscribeMessage | WsUserMessage;

/** Gateway → Client: result of an agent_event or user_message turn. */
export interface WsTurnResultMessage {
  type: 'turn_result';
  request_id?: string;
  suspended?: boolean;
  deduplicated?: boolean;
  version_hash?: string;
  occ_result?: string;
  /** Full assistant reply for a user_message turn (deltas already streamed). */
  reply?: string;
  /** Client-side mirror of a protocol error reply (set by the terminal client). */
  error?: string;
  context: unknown;
}

/** Gateway → Client: broadcast trail event (same shape as SSE). */
export interface WsTrailEventMessage extends TrailSseEvent {}

/** Gateway → Client: protocol-level error. */
export interface WsErrorMessage {
  type: 'error';
  request_id?: string;
  message: string;
}

export type WsServerMessage = WsTurnResultMessage | WsTrailEventMessage | WsErrorMessage;

// ── Dashboard state ──────────────────────────────────────────────────────────

/** Dashboard scope list item — REST snapshot shape (GET /v1/scopes). */
export interface DashboardScopeSummary extends Scope {
  event_count: number;
  conflict_count: number;
}

/** MemexTerminal session descriptor — zero state ownership: all fields derive from the graph. */
export interface TerminalSession {
  scope_id: string;
  /** Latest version_hash — the predecessor for the next event submission. */
  tip_hash: string;
  connected: boolean;
}
