/**
 * IQueueAdapter — Phase 2 Redis replacement point.
 *
 * Phase 1: PgQueueAdapter (FOR UPDATE SKIP LOCKED, pg LISTEN/NOTIFY wakeup).
 * Phase 2: RedisQueueAdapter drops in here without touching any Worker code.
 */

import type { EventLogNode } from '@graph/shared';

export interface IQueueAdapter {
  /**
   * Atomically claim and return the next pending_dispatch event for the given
   * scope, or null when none remain.  Uses FOR UPDATE SKIP LOCKED so concurrent
   * callers always receive different rows.
   */
  nextEvent(scopeId: string): Promise<EventLogNode | null>;

  /**
   * Register a callback that fires when a new event is ready to dispatch.
   * Wakeup signal only — no event data is carried in the notification payload.
   */
  onWakeup(cb: () => void): void;
}
