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
import { readPool } from './db/read-pool.js';

async function boot(): Promise<void> {
  // Register with iii engine — returns the worker handle used for trigger()
  const iiiWorker = registerWorker(
    process.env.III_URL ?? 'ws://localhost:49134',
    { workerName: 'control-plane' },
  );

  // Instantiate watchdog (uses readPool for convergence SQL and scope_closed writes)
  const watchdog = new ScopeConvergenceTracker(readPool);

  // Start Pulse-Fetch bridge — blocks on LISTEN subscription
  await startPulseFetch({ iiiWorker });

  console.log('[control-plane] Boot complete — watchdog and pulse-fetch active');

  // Expose watchdog on module exports for other components that need it
  return;
}

boot().catch((err) => {
  console.error('[control-plane] Fatal boot error:', err);
  process.exit(1);
});
