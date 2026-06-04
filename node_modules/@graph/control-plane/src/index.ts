/**
 * Control Plane Daemon — boot entry point.
 *
 * Boot sequence:
 *   1. Register iii worker 'control-plane'
 *   2. Start Pulse-Fetch bridge (pg-listen → HWM → iii.trigger)
 *   3. Instantiate Convergence Watchdog
 *
 * @see ADR 05 — Control Plane Daemon architecture
 * @see ADR 09 — Pulse-Fetch bridge
 * @see ADR 19 — Convergence Watchdog
 */
import { registerWorker } from 'iii-sdk';
import { startPulseFetch } from './pulse-fetch.js';
import { ScopeConvergenceTracker } from './watchdog.js';
import { createReadPool } from './db/read-pool.js';
import { logger, LOG_EVENTS } from '@graph/shared';

const log = logger.child({ component: 'control-plane' });

async function boot(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/graph';

  // Register with iii engine — returns the worker handle used for trigger()
  const iiiWorker = registerWorker(
    process.env.III_URL ?? 'ws://localhost:49134',
    { workerName: 'control-plane' },
  );

  const readPool = createReadPool(DATABASE_URL);

  // Instantiate watchdog (uses readPool for convergence SQL and scope_closed writes)
  const watchdog = new ScopeConvergenceTracker(readPool);

  // Start Pulse-Fetch bridge — blocks on LISTEN subscription
  await startPulseFetch({ iiiWorker, readPool, connectionString: DATABASE_URL });

  log.info(LOG_EVENTS.BOOT + ' complete — watchdog and pulse-fetch active');

  // Expose watchdog on module exports for other components that need it
  return;
}

boot().catch((err) => {
  log.fatal({ err }, LOG_EVENTS.BOOT_ERROR);
  process.exit(1);
});
