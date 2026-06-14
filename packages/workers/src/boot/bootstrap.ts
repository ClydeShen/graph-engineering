import type { Pool } from 'pg';
import { partitionTable } from '@graph/shared';
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
  // Pre-create the user-profile scope's PARTITION so UserProfileWorker's occWrite
  // (which targets the partition sub-table directly) has somewhere to land. Mirrors
  // nestScope() Phase 1 (ADR 05) for the fixed USER_PROFILE_SCOPE_ID, made idempotent
  // via to_regclass so re-boots are safe (D-2).
  //
  // The previous statement here could NEVER succeed: it INSERTed into the parent table
  // (PARTITION BY LIST has no partition for this scope → routing error) using a
  // non-canonical 'scope_initialized' event_type the CHECK constraint rejects. The
  // ON CONFLICT DO NOTHING never fired — the error throws before conflict resolution.
  const nodash = USER_PROFILE_SCOPE_ID.replace(/-/g, '');
  const partition = partitionTable(USER_PROFILE_SCOPE_ID);
  await pool.query(`
    DO $$
    BEGIN
      IF to_regclass('${partition}') IS NULL THEN
        CREATE TABLE ${partition}
          PARTITION OF execution_event_log
          FOR VALUES IN ('${USER_PROFILE_SCOPE_ID}');
        ALTER TABLE ${partition}
          ADD CONSTRAINT uk_scope_occ_${nodash} UNIQUE (predecessor_hash, scope_id);
        ALTER TABLE ${partition}
          ADD CONSTRAINT uk_scope_idem_${nodash} UNIQUE (scope_id, entity_id, version_hash);
        CREATE INDEX idx_scope_${nodash}_pending_lookup
          ON ${partition} (scope_id, status, event_id ASC)
          WHERE status IN ('pending_scheduling', 'pending_dispatch');
      END IF;
    END $$;
  `);
}
