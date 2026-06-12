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
 * UPSERT: the first advance creates the row (UPDATE-only never persisted a
 * position — bus_state stayed empty and every boot replayed from id 0,
 * re-triggering LLM-calling handlers; UX-audit U1). GREATEST guards against
 * regression on duplicate delivery.
 */
export async function advanceHwm(
  pool: Pool,
  workerId: string,
  eventId: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO bus_state (worker_id, last_processed_event_id)
     VALUES ($2, $1)
     ON CONFLICT (worker_id) DO UPDATE
     SET last_processed_event_id = GREATEST(bus_state.last_processed_event_id, EXCLUDED.last_processed_event_id)`,
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
