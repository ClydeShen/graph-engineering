import type { Pool } from 'pg';
import { USER_PROFILE_SCOPE_ID } from '../memory/user-profile.worker.js';

/**
 * Boot-time idempotent INSERT for all internal Workers into agent_registry.
 * ON CONFLICT (agent_id) DO NOTHING — re-boots are safe (D-2).
 * Stable UUIDs are fixed strings per Worker — never generated at runtime.
 */
export async function bootstrapAgentRegistry(pool: Pool): Promise<void> {
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
  // Pre-create the user-profile scope so occWrite can reference it as a valid foreign key (T4)
  await pool.query(`
    INSERT INTO execution_event_log (scope_id, entity_id, event_type, version_hash, status, payload)
    VALUES ($1::uuid, gen_random_uuid(), 'scope_initialized',
            encode(sha256('user-profile-scope'), 'hex'), 'completed', '{"scope":"user-profiles"}')
    ON CONFLICT DO NOTHING
  `, [USER_PROFILE_SCOPE_ID]);
}
