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

import { randomUUID } from 'crypto';
import { registerWorker, TriggerAction } from 'iii-sdk';
import { Pool } from 'pg';
import { OccEventWriter, createLLMProvider, OpenAICompatibleProvider, type LLMApi } from '@graph/shared';
import { PoolTrailReader } from './base/trail-reader.js';
import { PoolMemoryRepository } from './base/memory-repository.js';
import { bootstrapAgentRegistry } from './boot/bootstrap.js';
import { FrontierSchedulerWorker, FRONTIER_TRIGGER_CONFIG } from './scheduler/frontier.worker.js';
import { PatternDiscoveryWorker, PATTERN_DISCOVERY_CRON_TRIGGER } from './patterns/discover.worker.js';
import { ConflictResolverWorker, FUNCTION_ID as CONFLICT_RESOLVER_FUNCTION_ID } from './concrete/conflict-resolver.worker.js';
import { SemanticMemoryWorker, SEMANTIC_TRIGGER_CONFIG } from './memory/semantic.worker.js';
import { TemplateProposalWorker, TEMPLATE_PROPOSAL_TRIGGER_CONFIG } from './memory/template-proposal.worker.js';
import { memReflect, type MemReflectInput } from './memory/reflect.function.js';
import {
  MemorySynthesizerWorker,
  SYNTHESIZER_CRON_TRIGGER,
  DECAY_CRON_TRIGGER,
  TTL_CRON_TRIGGER,
} from './memory/synthesizer.worker.js';
import { ProceduralMemoryWorker, PROCEDURAL_TRIGGER_CONFIG } from './memory/procedural.worker.js';
import { SubScopeResultWorker, SUB_SCOPE_RESULT_TRIGGER_CONFIG } from './nested/sub-scope-result.worker.js';
import { CrystallizeWorker, CRYSTALLIZE_TRIGGER_CONFIG } from './memory/crystallize.worker.js';
import { LessonSaveWorker, LESSON_SAVE_TRIGGER_CONFIG } from './memory/lesson-save.worker.js';
import { McpClientWorker, MCP_CLIENT_TRIGGER_CONFIG } from './integrations/mcp-client.worker.js';
import { UserProfileWorker, USER_PROFILE_TRIGGER_CONFIG } from './memory/user-profile.worker.js';

// ---------------------------------------------------------------------------
// Config sourced from env — Workers receive injected instances, not raw env
// ---------------------------------------------------------------------------

const III_URL = process.env['III_URL'] ?? 'ws://localhost:49134';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/graph';

const pool = new Pool({ connectionString: DATABASE_URL });
const trailReader = new PoolTrailReader(pool);
const memory = new PoolMemoryRepository(pool);
const eventWriter = new OccEventWriter(pool);

// D-2 AgentCard universalization — boot-time idempotent INSERT for all internal Workers.
void bootstrapAgentRegistry(pool).catch(() => {
  // Best-effort: agent_registry bootstrap failure must not crash the worker process (D-2)
});

const llmProvider = createLLMProvider({
  api: (process.env['LLM_API'] ?? 'openai-completions') as LLMApi,
  model: process.env['LLM_MODEL'] ?? 'llama3',
  baseUrl: process.env['LLM_BASE_URL'],
  apiKey: process.env['LLM_API_KEY'] ?? '',
  maxTokens: process.env['LLM_MAX_TOKENS'] ? Number(process.env['LLM_MAX_TOKENS']) : undefined,
});

// Anthropic has no embeddings endpoint — embedding always uses openai-completions.
const embeddingProvider = new OpenAICompatibleProvider({
  api: 'openai-completions',
  model: process.env['EMBEDDING_MODEL'] ?? process.env['LLM_MODEL'] ?? 'llama3',
  baseUrl: process.env['LLM_BASE_URL'],
  apiKey: process.env['LLM_API_KEY'] ?? '',
});

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------

const worker = registerWorker(III_URL, { workerName: 'graph-workers' });

/** Pair a trigger config with its typed handler and register both in one call. */
function reg<T = unknown>(
  config: { function_id: string },
  handler: (payload: T) => Promise<unknown>,
): void {
  worker.registerFunction(config.function_id, async (raw: unknown) => handler(raw as T));
  worker.registerTrigger(config as Parameters<typeof worker.registerTrigger>[0]);
}

// graph::conflict-resolver — Phase 2: LLM-assisted semantic merge (ADR 22)
// No registerTrigger — invoked directly by the OCC conflict path, not via a trigger config.
const conflictResolverWorker = new ConflictResolverWorker(llmProvider, pool);
worker.registerFunction(CONFLICT_RESOLVER_FUNCTION_ID, async (payload: unknown) => {
  const p = payload as { entity_id: string; payload_a: string; payload_b: string };
  return conflictResolverWorker.onConflict(p.entity_id, p.payload_a, p.payload_b);
});

// graph::scheduler::frontier — token bucket dispatch, NO LLM call (ADR 31)
const frontierScheduler = new FrontierSchedulerWorker(pool);
reg<{ scope_id?: string }>(FRONTIER_TRIGGER_CONFIG, async (p) => {
  if (p?.scope_id) {
    await frontierScheduler.onFrontierChanged(p.scope_id);
  }
  return { dispatched: true };
});

// graph::memory::semantic — durable:subscriber on graph::scope::closed
const semanticWorker = new SemanticMemoryWorker(trailReader, memory, eventWriter, llmProvider, embeddingProvider);
reg<{ scope_id: string; entity_id: string; predecessor_hash: string }>(
  SEMANTIC_TRIGGER_CONFIG,
  async (p) => {
    await semanticWorker.onScopeClosed(p.scope_id, p.entity_id, p.predecessor_hash);
    return { written: true };
  },
);

// graph::memory::template-proposal — durable:subscriber on graph::scope::closed (D-01 Phase 09)
const templateProposalWorker = new TemplateProposalWorker(trailReader, memory, eventWriter, llmProvider, embeddingProvider);
reg<{ scope_id: string; entity_id: string; predecessor_hash: string }>(
  TEMPLATE_PROPOSAL_TRIGGER_CONFIG,
  async (p) => {
    await templateProposalWorker.onScopeClosed(p.scope_id, p.entity_id, p.predecessor_hash);
    return { written: true };
  },
);

// graph::memory::synthesizer — cron 2AM, batch distillation episodic→procedural
// Complex inline handler: queries DB, iterates, triggers downstream worker.
const synthesizerWorker = new MemorySynthesizerWorker(trailReader, memory, llmProvider);
worker.registerFunction(SYNTHESIZER_CRON_TRIGGER.function_id, async (_payload: unknown) => {
  const { rows: scopeRows } = await pool.query<{ scope_id: string }>(
    `SELECT DISTINCT scope_id FROM episodic_memory
     WHERE created_at > NOW() - INTERVAL '25 hours'
     LIMIT 10`,
  );
  let processed = 0;
  for (const { scope_id } of scopeRows) {
    const result = await synthesizerWorker.runSynthesis(scope_id);
    if (!result.skipped) {
      await worker.trigger({
        function_id: PROCEDURAL_TRIGGER_CONFIG.function_id,
        payload: {
          scope_id: result.scope_id,
          entity_id: randomUUID(),
          predecessor_hash: '0'.repeat(64),
          intent_description: result.intent_description,
          template_graph: result.template_graph,
          nodes: result.nodes,
          edges: result.edges,
        },
        action: TriggerAction.Void(),
      });
      processed++;
    }
  }
  return { processed };
});
worker.registerTrigger(SYNTHESIZER_CRON_TRIGGER);

// graph::memory::decay — cron 3AM, Ebbinghaus decay scan (G3-6)
reg(DECAY_CRON_TRIGGER, () => synthesizerWorker.runDecay().then(() => ({ done: true })));

// graph::memory::ttl — cron 4AM, working_memory 24h TTL purge
reg(TTL_CRON_TRIGGER, () => synthesizerWorker.runTtlPurge().then(() => ({ done: true })));

// graph::memory::procedural — durable:subscriber on graph::memory::synthesizer::output
const proceduralWorker = new ProceduralMemoryWorker(memory, eventWriter, embeddingProvider);
reg<{
  scope_id: string;
  entity_id: string;
  predecessor_hash: string;
  template_graph: unknown;
  intent_description: string;
  nodes: { id: string; event_type: string }[];
  edges: { source: string; target: string }[];
}>(PROCEDURAL_TRIGGER_CONFIG, async (p) => {
  await proceduralWorker.onSynthesizerOutput(
    p.scope_id,
    p.entity_id,
    p.predecessor_hash,
    p.template_graph,
    p.intent_description,
    p.nodes,
    p.edges,
  );
  return { written: true };
});

// graph::scope::sub-scope-result — durable:subscriber on graph::scope::sub_scope_resolved
const subScopeResultWorker = new SubScopeResultWorker(trailReader, eventWriter, llmProvider);
reg<{
  child_scope_id: string;
  trigger_task_id: string;
  child_final_version_hash: string;
  parent_scope_id: string;
}>(SUB_SCOPE_RESULT_TRIGGER_CONFIG, async (p) => {
  await subScopeResultWorker.onSubScopeResolved(p);
  return { written: true };
});

// graph::memory::crystallize — durable:subscriber on graph::scope::closed
const crystallizeWorker = new CrystallizeWorker(trailReader, memory, eventWriter, llmProvider, worker);
reg<{ scope_id: string; entity_id: string; predecessor_hash: string }>(
  CRYSTALLIZE_TRIGGER_CONFIG,
  (p) => crystallizeWorker.onScopeClosed(p.scope_id, p.entity_id, p.predecessor_hash),
);

// graph::memory::lesson-save — durable:subscriber triggered by CrystallizeWorker
const lessonSaveWorker = new LessonSaveWorker(memory);
reg<{ content: string; confidence?: number }>(
  LESSON_SAVE_TRIGGER_CONFIG,
  (p) => lessonSaveWorker.onLessonSave(p),
);

// graph::integration::mcp-client — startup: connect to external MCP servers
// Also directly calls connect() at boot (not trigger-driven), so kept inline.
const mcpClientWorker = new McpClientWorker(eventWriter);
worker.registerFunction(MCP_CLIENT_TRIGGER_CONFIG.function_id, async (_: unknown) => {
  await mcpClientWorker.connect((name, fn) => worker.registerFunction(name, fn));
  return { connected: true };
});
void mcpClientWorker.connect((name, fn) => worker.registerFunction(name, fn));

// graph::memory::user-profile — 3AM daily cron: synthesize cross-scope user profile from Crystals (T4)
const userProfileWorker = new UserProfileWorker(pool, llmProvider);
reg(USER_PROFILE_TRIGGER_CONFIG, () => userProfileWorker.scanAllUsers());

// graph::patterns::discover — 6h cron, base_priority=1, MIN_CORPUS guard (ADR 37)
const patternDiscovery = new PatternDiscoveryWorker();
reg(PATTERN_DISCOVERY_CRON_TRIGGER, () => patternDiscovery.runDiscovery(pool));

// mem::reflect — Reflection Track hybrid retrieval (ADR-21, D-12 Phase 09)
// No registerTrigger — invoked directly via worker.trigger() or
// runContextAssemblyPipeline opts.memReflect.fn, not by a topic subscription.
worker.registerFunction('mem::reflect', async (raw: unknown) => {
  return memReflect(pool, embeddingProvider, raw as MemReflectInput);
});

// ---------------------------------------------------------------------------
// Re-exports for library consumers (HTTP Gateway uses context assembly utils)
// ---------------------------------------------------------------------------

export * from './context/assemble.js';
export * from './context/knapsack.js';
export * from './context/overflow.js';
