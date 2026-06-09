/**
 * MemexTerminal display/SSE types for the Graph-Native Agent Runtime shell layer.
 *
 * This module is a leaf: it imports no @graph/* packages.
 */

/**
 * Server-Sent Event (SSE) shape for streaming Trail events to MemexTerminal.
 * Used by the SSE endpoint to push live graph activity to connected terminal clients.
 */
export interface TrailSseEvent {
  type: 'trail_event';
  event_type: string;
  payload: unknown;
  scope_id: string;
  timestamp: string;
}
