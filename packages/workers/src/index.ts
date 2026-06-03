/**
 * @graph/workers — boot entry point.
 *
 * ALL Worker registrations happen here and ONLY here.
 * FrontierSchedulerWorker and PatternDiscoveryWorker export their trigger
 * config constants but do NOT self-register — this is the single boot entry point.
 *
 * Credentials and connection strings are read from env vars here and injected
 * into workers. No Worker or provider module reads process.env directly.
 *
 * @see ADR 22 — credentials in config only
 * @see ADR 31 — FrontierScheduler registration
 * @see ADR 37 — PatternDiscovery cron registration
 */

import { registerWorker } from 'iii-sdk';
import { Pool } from 'pg';
import { OpenAICompatibleProvider } from '@graph/shared';
import { FrontierSchedulerWorker, FRONTIER_TRIGGER_CONFIG } from './scheduler/frontier.worker.js';
import { PatternDiscoveryWorker, PATTERN_DISCOVERY_CRON_TRIGGER } from './patterns/discover.worker.js';
import { ContextAssemblyWorker } from './concrete/context-assembly.worker.js';
import { ConflictResolverWorker } from './concrete/conflict-resolver.worker.js';

// ---------------------------------------------------------------------------
// Config sourced from env — Workers receive injected instances, not raw env
// ---------------------------------------------------------------------------

const III_URL = process.env['III_URL'] ?? 'ws://localhost:49134';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/graph';

const pool = new Pool({ connectionString: DATABASE_URL });

// LLM CALL — provider instance constructed here; credentials from iii-config.yaml
// env interpolation (ADR 22: Workers call interface, never hold credentials).
const llmProvider = new OpenAICompatibleProvider({
  baseUrl: process.env['LLM_BASE_URL'] ?? 'http://localhost:11434',
  model: process.env['LLM_MODEL'] ?? 'llama3',
  apiKey: process.env['LLM_API_KEY'] ?? '',
});

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

const worker = registerWorker(III_URL, { workerName: 'graph-workers' });

// graph::context-assembly
const contextAssemblyWorker = new ContextAssemblyWorker();
worker.registerFunction('graph::context-assembly', async (payload: unknown) => {
  // Lifecycle invocation delegated to worker instance via iii-sdk payload
  void llmProvider; // provider available for future Phase 2 context compression
  void contextAssemblyWorker;
  return payload;
});

// graph::conflict-resolver (Phase 1 stub — OCC hard-stop handles conflicts)
const conflictResolverWorker = new ConflictResolverWorker();
worker.registerFunction('graph::conflict-resolver', async (payload: unknown) => {
  void conflictResolverWorker;
  return payload;
});

// graph::scheduler::frontier — token bucket dispatch, NO LLM call (ADR 31)
const frontierScheduler = new FrontierSchedulerWorker(pool);
worker.registerFunction('graph::scheduler::frontier', async (payload: unknown) => {
  const p = payload as { scope_id?: string };
  if (p?.scope_id) {
    await frontierScheduler.onFrontierChanged(p.scope_id);
  }
  return { dispatched: true };
});
worker.registerTrigger(FRONTIER_TRIGGER_CONFIG);

// graph::patterns::discover — 6h cron, base_priority=1, MIN_CORPUS guard (ADR 37)
const patternDiscovery = new PatternDiscoveryWorker();
worker.registerFunction('graph::patterns::discover', async (_payload: unknown) => {
  return patternDiscovery.runDiscovery(pool);
});
worker.registerTrigger(PATTERN_DISCOVERY_CRON_TRIGGER);

// ---------------------------------------------------------------------------
// Re-exports for library consumers (HTTP Gateway uses context assembly utils)
// ---------------------------------------------------------------------------

export * from './context/assemble.js';
export * from './context/knapsack.js';
export * from './context/overflow.js';
