/**
 * Pulse-Fetch bridge: pg-listen subscriber → HWM advance → iii.trigger()
 *
 * Boot order (Pitfall 3 — MUST be preserved):
 *   1. await subscriber.connect()
 *   2. await subscriber.listenTo('graph_event_ready')
 *   3. read HWM from bus_state
 *   4. replay missed events with id > hwm
 *
 * LISTEN/NOTIFY carries ≤64B pulse only (event_id in payload).
 * The full event is always fetched via point-query on readPool.
 *
 * API: subscriber.notifications.on() — pg-listen EventEmitter pattern
 *
 * @see ADR 09 — Pulse-Fetch bridge design
 * @see ADR 32 D-4 — LISTEN/NOTIFY carries no data, wakeup signal only
 * @see RESEARCH.md Pattern 2 — pg-listen exact API
 * @see RESEARCH.md Pitfall 2 — notifications.on is the correct API
 * @see RESEARCH.md Pitfall 3 — boot order: LISTEN before HWM read
 */
import createSubscriber from 'pg-listen';
import type { Pool } from 'pg';
import { advanceHwm, readHwm } from './hwm.js';
import { logger, LOG_EVENTS } from '@graph/shared';

const log = logger.child({ component: 'control-plane', module: 'pulse-fetch' });

const CHANNEL = 'graph_event_ready';
const CONTROL_PLANE_WORKER_ID = 'control-plane';

/**
 * Dedicated topic for sub_scope_resolved events.
 * SubScopeResultWorker (Plan 03-06) registers a durable:subscriber on this topic.
 * Exported so Plan 06 imports the identical string — no magic string duplication.
 *
 * sub_scope_resolved is a Control Plane direct-write that bypasses the bus enum
 * (ADR 12 / ADR 23). It must NOT route to graph::scheduler::frontier — doing so
 * would cause FrontierScheduler to treat it as a dispatchable frontier node.
 *
 * @see ADR 23 §4 — 总线感知到此事件后，激活 SubScopeResultWorker 订阅
 * @see RESEARCH.md Pitfall 3 — iii-sdk rejects non-canonical event types; use topic routing
 */
export const SUB_SCOPE_TOPIC = 'graph::scope::sub_scope_resolved';

export interface PulseFetchDeps {
  iiiWorker: {
    trigger(args: { function_id: string; payload: unknown }): Promise<void>;
  };
  readPool: Pool;
  connectionString: string;
}

export async function startPulseFetch(deps: PulseFetchDeps): Promise<void> {
  const { iiiWorker, readPool, connectionString } = deps;

  const subscriber = createSubscriber({ connectionString });

  // ── Boot order: connect → listenTo → readHwm → replay ───────────────────

  // Step 1: Connect the subscriber (dedicated internal client)
  await subscriber.connect();

  // Step 2: Subscribe to channel BEFORE reading HWM to avoid gap
  await subscriber.listenTo(CHANNEL);

  // Step 3: Read current HWM
  const hwm = await readHwm(readPool, CONTROL_PLANE_WORKER_ID);

  // Step 4: Replay any events missed since HWM (capped at REPLAY_LIMIT to prevent restart flood)
  const REPLAY_LIMIT = 1000;
  const missed = await readPool.query<{ id: number; event_type: string; scope_id: string }>(
    `SELECT id, event_type, entity_id, scope_id, payload, predecessor_hash, version_hash
     FROM execution_event_log
     WHERE id > $1
     ORDER BY id ASC
     LIMIT $2`,
    [hwm, REPLAY_LIMIT],
  );
  if (missed.rows.length === REPLAY_LIMIT) {
    log.warn({ hwm, limit: REPLAY_LIMIT }, LOG_EVENTS.PULSE_FETCH + ' replay capped — consider advancing HWM manually');
  }
  for (const row of missed.rows) {
    log.debug({ event_id: row.id, event_type: row.event_type }, LOG_EVENTS.PULSE_REPLAY);
    await advanceHwm(readPool, CONTROL_PLANE_WORKER_ID, row.id);
    // sub_scope_resolved routes to its own topic — NOT the frontier topic (ADR 23)
    if (row.event_type === 'sub_scope_resolved') {
      await iiiWorker.trigger({
        function_id: SUB_SCOPE_TOPIC,
        payload: { scope_id: row.scope_id, event_id: row.id },
      });
    } else {
      await iiiWorker.trigger({
        function_id: 'graph::scheduler::frontier',
        payload: { scope_id: row.scope_id },
      });
    }
  }

  // ── Register notification handler ────────────────────────────────────────
  // IMPORTANT: use subscriber.notifications.on() — pg-listen EventEmitter pattern
  subscriber.notifications.on(CHANNEL, async (rawPayload: unknown) => {
    let eventId: number | undefined;
    try {
      const parsed =
        typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
      eventId = Number(parsed?.id);
    } catch {
      log.error({ raw: rawPayload }, LOG_EVENTS.PULSE_ERROR + ' failed to parse notification');
      return;
    }

    if (!eventId || isNaN(eventId)) {
      log.warn({ raw: rawPayload }, LOG_EVENTS.PULSE_ERROR + ' notification missing id');
      return;
    }

    // Point-query the full event row
    const result = await readPool.query<{
      id: number;
      event_type: string;
      entity_id: string;
      scope_id: string;
      payload: string;
      predecessor_hash: string;
      version_hash: string;
    }>(
      `SELECT id, event_type, entity_id, scope_id, payload, predecessor_hash, version_hash
       FROM execution_event_log WHERE id = $1`,
      [eventId],
    );

    if (result.rows.length === 0) {
      // Race condition: event already processed or not yet visible
      return;
    }

    const event = result.rows[0];

    // Advance HWM before triggering (ADR 09 ordering guarantee)
    await advanceHwm(readPool, CONTROL_PLANE_WORKER_ID, event.id);

    // Route by event_type: sub_scope_resolved gets its own dedicated topic (ADR 23).
    // All other event types route to Frontier Scheduler as before.
    if (event.event_type === 'sub_scope_resolved') {
      await iiiWorker.trigger({
        function_id: SUB_SCOPE_TOPIC,
        payload: { scope_id: event.scope_id, event_id: event.id },
      });
    } else {
      // Route to Frontier Scheduler — passes scope_id for priority queue update
      await iiiWorker.trigger({
        function_id: 'graph::scheduler::frontier',
        payload: { scope_id: event.scope_id },
      });
    }
  });

  // pg-listen auto-reconnects — log errors but do NOT exit the process
  subscriber.events.on('error', (err: Error) => {
    log.error({ err: err.message }, LOG_EVENTS.PULSE_ERROR + ' pg-listen reconnecting');
  });

  log.info({ channel: CHANNEL, hwm }, LOG_EVENTS.PULSE_FETCH + ' subscribed');
}
