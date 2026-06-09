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
import { FrontierSchedulerWorker, FRONTIER_TRIGGER_CONFIG } from './scheduler/frontier.worker.js';
import { PatternDiscoveryWorker, PATTERN_DISCOVERY_CRON_TRIGGER } from './patterns/discover.worker.js';
import { ConflictResolverWorker } from './concrete/conflict-resolver.worker.js';
import { EpisodicMemoryWorker, EPISODIC_TRIGGER_CONFIG } from './memory/episodic.worker.js';
import { createLLMProvider, OpenAICompatibleProvider, type LLMApi } from '@graph/shared';
import { SemanticMemoryWorker, SEMANTIC_TRIGGER_CONFIG } from './memory/semantic.worker.js';
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
import { McpClientWorker } from './integrations/mcp-client.worker.js';

// ---------------------------------------------------------------------------
// Config sourced from env — Workers receive injected instances, not raw env
// ---------------------------------------------------------------------------

const III_URL = process.env['III_URL'] ?? 'ws://localhost:49134';
const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/graph';

const pool = new Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// D-2 AgentCard universalization — boot-time idempotent INSERT for all
// internal Workers. ON CONFLICT (agent_id) DO NOTHING: re-boots are safe.
// Stable UUIDs are fixed strings per Worker — never generated at runtime.
// Skills vocabulary (coarse, consistent): see .harness/implementation-notes.md
// ---------------------------------------------------------------------------
void (async () => {
  try {
    await pool.query(`
      INSERT INTO agent_registry
        (agent_id, name, description, skills, protocol, endpoint, agent_card_json, status)
      VALUES
        ('a1000000-0000-4000-8000-000000000001', 'FrontierSchedulerWorker',
         'Token-bucket task dispatch with skill-based SKIP LOCKED routing (ADR 31)',
         ARRAY['task-routing', 'task-dispatch'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000002', 'EpisodicMemoryWorker',
         'Appends execution trace events to episodic_memory (Phase 1 C1)',
         ARRAY['memory-storage', 'episodic-recall'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000003', 'SemanticMemoryWorker',
         'Distils episodic records into semantic_memory via LLM on scope close (ADR 22)',
         ARRAY['memory-storage', 'semantic-retrieval'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000004', 'ProceduralMemoryWorker',
         'Stores WL-embedded workflow templates into procedural_memory (ADR 25)',
         ARRAY['memory-storage', 'template-learning'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000005', 'ConflictResolverWorker',
         'LLM-assisted semantic merge of conflicting OCC writes (ADR 22)',
         ARRAY['conflict-resolution'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000006', 'SubScopeResultWorker',
         'Synthesizes child scope results via LLM and writes memory_updated to parent (ADR 23)',
         ARRAY['scope-resolution', 'result-synthesis'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000007', 'PatternDiscoveryWorker',
         'WL graph kernel cross-domain pattern clustering (ADR 25, ADR 37)',
         ARRAY['pattern-discovery', 'cross-domain-clustering'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000008', 'CrystallizeWorker',
         'Real-time LLM digest on scope close: episodic traces → Crystal entity (Phase 4)',
         ARRAY['memory-storage', 'crystallization'], 'iii', NULL, '{}', 'active'),
        ('a1000000-0000-4000-8000-000000000009', 'LessonSaveWorker',
         'Content-addressed lesson dedup with Ebbinghaus confidence reinforcement (Phase 4)',
         ARRAY['memory-storage', 'lesson-dedup'], 'iii', NULL, '{}', 'active')
      ON CONFLICT (agent_id) DO NOTHING
    `);
  } catch {
    // Best-effort: agent_registry bootstrap failure must not crash the worker process (D-2)
  }
})();

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

// graph::conflict-resolver — Phase 2: LLM-assisted semantic merge (ADR 22)
const conflictResolverWorker = new ConflictResolverWorker(llmProvider, pool);
worker.registerFunction('graph::conflict-resolver', async (payload: unknown) => {
  const p = payload as { entity_id: string; payload_a: string; payload_b: string };
  return conflictResolverWorker.onConflict(p.entity_id, p.payload_a, p.payload_b);
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

// graph::memory::episodic — durable:subscriber on graph::memory::episodic::ingest
// Writes to episodic_memory on task_spawned/memory_updated events.
// Phase 1 constraint C1: also fires memory_updated event to execution_event_log.
const episodicWorker = new EpisodicMemoryWorker(pool);
worker.registerFunction('graph::memory::episodic', async (payload: unknown) => {
  const p = payload as {
    scope_id: string;
    entity_id: string;
    content: string;
    predecessor_hash: string;
  };
  await episodicWorker.onEvent(p.scope_id, p.entity_id, p.content, p.predecessor_hash);
  return { written: true };
});
worker.registerTrigger(EPISODIC_TRIGGER_CONFIG);

// graph::memory::semantic — durable:subscriber on graph::scope::closed
// Distils episodic records into semantic_memory via LLM on scope close.
// Phase 1 constraint C1: also fires memory_updated event to execution_event_log.
const semanticWorker = new SemanticMemoryWorker(pool, llmProvider);
worker.registerFunction('graph::memory::semantic', async (payload: unknown) => {
  const p = payload as {
    scope_id: string;
    entity_id: string;
    predecessor_hash: string;
  };
  await semanticWorker.onScopeClosed(p.scope_id, p.entity_id, p.predecessor_hash);
  return { written: true };
});
worker.registerTrigger(SEMANTIC_TRIGGER_CONFIG);

// graph::memory::synthesizer — cron 2AM, batch distillation episodic→procedural
// Queries distinct scope_ids with recent episodic records; synthesizes each independently.
const synthesizerWorker = new MemorySynthesizerWorker(pool, llmProvider);
worker.registerFunction('graph::memory::synthesizer', async (_payload: unknown) => {
  const { rows: scopeRows } = await pool.query<{ scope_id: string }>(
    `SELECT DISTINCT scope_id FROM episodic_memory
     WHERE created_at > NOW() - INTERVAL '25 hours'
     LIMIT 10`,
  );
  let processed = 0;
  for (const { scope_id } of scopeRows) {
    const result = await synthesizerWorker.runSynthesis(scope_id);
    if (!result.skipped) {
      // Trigger ProceduralMemoryWorker — synthesizer→procedural publish link.
      // TriggerAction.Void() = fire-and-forget; no need to await the procedural write.
      await worker.trigger({
        function_id: 'graph::memory::procedural',
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
worker.registerFunction('graph::memory::decay', async (_payload: unknown) => {
  await synthesizerWorker.runDecay();
  return { done: true };
});
worker.registerTrigger(DECAY_CRON_TRIGGER);

// graph::memory::ttl — cron 4AM, working_memory 24h TTL purge
worker.registerFunction('graph::memory::ttl', async (_payload: unknown) => {
  await synthesizerWorker.runTtlPurge();
  return { done: true };
});
worker.registerTrigger(TTL_CRON_TRIGGER);

// graph::memory::procedural — durable:subscriber on graph::memory::synthesizer::output
// Stores WL-embedded workflow templates into procedural_memory.
// Phase 1 constraint C1: also fires memory_updated event to execution_event_log.
const proceduralWorker = new ProceduralMemoryWorker(pool, embeddingProvider);
worker.registerFunction('graph::memory::procedural', async (payload: unknown) => {
  const p = payload as {
    scope_id: string;
    entity_id: string;
    predecessor_hash: string;
    template_graph: unknown;
    intent_description: string;
    nodes: { id: string; event_type: string }[];
    edges: { source: string; target: string }[];
  };
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
worker.registerTrigger(PROCEDURAL_TRIGGER_CONFIG);

// graph::scope::sub-scope-result — durable:subscriber on graph::scope::sub_scope_resolved
// Reads child final node, calls LLM to synthesize result_summary, writes memory_updated
// to the parent scope so the spawning task advances to completed (ADR 23 step 3).
const subScopeResultWorker = new SubScopeResultWorker(pool, llmProvider);
worker.registerFunction('graph::scope::sub-scope-result', async (payload: unknown) => {
  const p = payload as {
    child_scope_id: string;
    trigger_task_id: string;
    child_final_version_hash: string;
    parent_scope_id: string;
  };
  await subScopeResultWorker.onSubScopeResolved(p);
  return { written: true };
});
worker.registerTrigger(SUB_SCOPE_RESULT_TRIGGER_CONFIG);

// graph::memory::crystallize — durable:subscriber on graph::scope::closed
// Real-time LLM digest: episodic records → Crystal entity → triggers lesson-save (Phase 4 T4)
const crystallizeWorker = new CrystallizeWorker(pool, llmProvider, worker);
worker.registerFunction('graph::memory::crystallize', async (payload: unknown) => {
  const p = payload as { scope_id: string; entity_id: string; predecessor_hash: string };
  return crystallizeWorker.onScopeClosed(p.scope_id, p.entity_id, p.predecessor_hash);
});
worker.registerTrigger(CRYSTALLIZE_TRIGGER_CONFIG);

// graph::memory::lesson-save — durable:subscriber triggered by CrystallizeWorker
// Content-addressed dedup + Ebbinghaus confidence reinforcement (Phase 4 T4)
const lessonSaveWorker = new LessonSaveWorker(pool);
worker.registerFunction('graph::memory::lesson-save', async (payload: unknown) => {
  const p = payload as { content: string; confidence?: number };
  return lessonSaveWorker.onLessonSave(p);
});
worker.registerTrigger(LESSON_SAVE_TRIGGER_CONFIG);

// graph::integration::mcp-client — startup: connect to external MCP servers, register per-tool iii functions
const mcpClientWorker = new McpClientWorker(pool);
worker.registerFunction('graph::integration::mcp-client', async (_: unknown) => {
  await mcpClientWorker.connect((name, fn) => worker.registerFunction(name, fn));
  return { connected: true };
});
// Connect immediately at boot so tools are available without waiting for trigger
void mcpClientWorker.connect((name, fn) => worker.registerFunction(name, fn));

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
