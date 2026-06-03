/**
 * High-Water Mark (HWM) tracking for the Pulse-Fetch bridge.
 *
 * HWM is stored in bus_state.last_processed_event_id per worker.
 * The UPDATE guard `last_processed_event_id < $1` prevents regression
 * (safe under concurrent delivery or reconnect replay).
 *
 * @see ADR 09 — Pulse-Fetch: HWM advance before iii.trigger()
 * @see ADR 32 D-4 — bus_state HWM per worker_id
 */
import type { Pool } from 'pg';

/**
 * Advance the HWM for a worker to eventId, but only if eventId is newer.
 * The conditional UPDATE prevents HWM regression on duplicate delivery.
 */
export async function advanceHwm(
  pool: Pool,
  workerId: string,
  eventId: number,
): Promise<void> {
  await pool.query(
    `UPDATE bus_state
     SET last_processed_event_id = $1
     WHERE worker_id = $2 AND last_processed_event_id < $1`,
    [eventId, workerId],
  );
}

/**
 * Read the current HWM for a worker.
 * Returns 0 if no row exists (first boot, no events processed yet).
 */
export async function readHwm(pool: Pool, workerId: string): Promise<number> {
  const result = await pool.query<{ last_processed_event_id: number | null }>(
    `SELECT last_processed_event_id FROM bus_state WHERE worker_id = $1`,
    [workerId],
  );
  return result.rows[0]?.last_processed_event_id ?? 0;
}
