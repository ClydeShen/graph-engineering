/**
 * Gate 3 integration tests — Phase 2: Memory & Retrieval
 *
 * Requires a real PostgreSQL database with migrations 001-006 applied.
 * Set DATABASE_URL env var to run. Tests skip automatically when DATABASE_URL is absent.
 *
 * G3-1: episodic_memory receives rows after EpisodicMemoryWorker.onEvent
 * G3-2: semantic_memory receives rows after SemanticMemoryWorker.onScopeClosed
 * G3-3: procedural_memory receives rows with non-NULL topology_embedding
 * G3-4: GET /v1/memory/search returns 200 with results array
 * G3-5: duplicate insertWorkingMemory within 5 min → only 1 row in working_memory
 * G3-6: Ebbinghaus decay sets superseded_by = id for stale records
 * G3-7: Gate 2 regression — GET /v1/sys/health returns 200
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { PoolTrailReader } from '../base/trail-reader.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

let pool: Pool;

beforeAll(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  if (skip) return;
  await pool.end();
});

// ── G3-1: EpisodicMemoryWorker inserts row ────────────────────────────────────

it.skipIf(skip)('G3-1: episodic_memory receives a row after EpisodicMemoryWorker.onEvent', async () => {
  const { EpisodicMemoryWorker } = await import('./episodic.worker.js');

  const scopeId = randomUUID();
  const entityId = randomUUID();
  const predecessorHash = '0'.repeat(64);
  const content = 'Test execution trace G3-1';

  const worker = new EpisodicMemoryWorker(pool);
  try {
    await worker.onEvent(scopeId, entityId, content, predecessorHash);
  } catch {
    // C1 occWrite may fail if scope not bootstrapped in execution_event_log.
    // INSERT committed before occWrite — row exists regardless.
  }

  const { rows } = await pool.query(
    `SELECT id, scope_id, content FROM episodic_memory WHERE scope_id = $1`,
    [scopeId],
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows[0]).toMatchObject({ scope_id: scopeId });
});

// ── G3-2: SemanticMemoryWorker inserts row ────────────────────────────────────

it.skipIf(skip)('G3-2: semantic_memory receives a row after SemanticMemoryWorker.onScopeClosed', async () => {
  const { SemanticMemoryWorker } = await import('./semantic.worker.js');

  const scopeId = randomUUID();

  await pool.query(
    `INSERT INTO episodic_memory (scope_id, content, created_at) VALUES ($1, $2, NOW())`,
    [scopeId, 'Seeded episodic record for G3-2'],
  );

  const mockLlm = { chat: async () => 'Distilled fact from G3-2 test' };
  const worker = new SemanticMemoryWorker(new PoolTrailReader(pool), pool, mockLlm as never);
  try {
    await worker.onScopeClosed(scopeId, randomUUID(), '0'.repeat(64));
  } catch {
    // C1 occWrite may fail without bootstrapped scope
  }

  const { rows } = await pool.query(
    `SELECT id, scope_id, content FROM semantic_memory WHERE scope_id = $1`,
    [scopeId],
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows[0]).toMatchObject({ scope_id: scopeId });
});

// ── G3-3: ProceduralMemoryWorker inserts row with non-NULL embedding ──────────

it.skipIf(skip)('G3-3: procedural_memory receives a row with non-NULL topology_embedding', async () => {
  const { ProceduralMemoryWorker } = await import('./procedural.worker.js');

  const scopeId = randomUUID();
  const nodes = [{ id: 'n1', event_type: 'task_spawned' }, { id: 'n2', event_type: 'scope_closed' }];
  const edges = [{ source: 'n1', target: 'n2' }];
  // Minimal EmbeddingProvider stub — embed failures fall back to NULL intent_embedding (safe)
  const mockLlmForG3 = { embed: async () => ({ vector: [], countedAgainstBudget: false as const }) };
  const worker = new ProceduralMemoryWorker(pool, mockLlmForG3);

  try {
    await worker.onSynthesizerOutput(
      scopeId,
      randomUUID(),
      '0'.repeat(64),
      { steps: ['step1', 'step2'] },
      'Test workflow template G3-3',
      nodes,
      edges,
    );
  } catch {
    // C1 occWrite may fail without bootstrapped scope
  }

  const { rows } = await pool.query(
    `SELECT id, scope_id, topology_embedding FROM procedural_memory WHERE scope_id = $1`,
    [scopeId],
  );
  expect(rows.length).toBeGreaterThanOrEqual(1);
  expect(rows[0]?.topology_embedding).not.toBeNull();
});

// ── G3-4: GET /v1/memory/search returns 200 ──────────────────────────────────

it.skipIf(skip)('G3-4: GET /v1/memory/search returns 200 with results array', async () => {
  const { buildApp } = await import('@graph/gateway/index.js');

  const app = buildApp(pool, pool, 4096);
  const scopeId = randomUUID();
  const res = await app.fetch(
    new Request(`http://localhost/v1/memory/search?q=test&scope_id=${scopeId}`),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: unknown[] };
  expect(Array.isArray(body.results)).toBe(true);
});

// ── G3-5: Working memory dedup within 5 minutes ───────────────────────────────

it.skipIf(skip)('G3-5: duplicate insertWorkingMemory within 5 min → only 1 row in working_memory', async () => {
  const { insertWorkingMemory } = await import('./working-memory.js');

  const scopeId = randomUUID();
  const entityId = randomUUID();
  const content = 'Identical content for dedup test G3-5';

  const r1 = await insertWorkingMemory(pool, scopeId, entityId, 'task_spawned', content);
  const r2 = await insertWorkingMemory(pool, scopeId, entityId, 'task_spawned', content);

  expect(r1.inserted).toBe(true);
  expect(r2.inserted).toBe(false);

  const { rows } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM working_memory WHERE scope_id = $1`,
    [scopeId],
  );
  expect(rows[0]?.count).toBe(1);
});

// ── G3-6: Ebbinghaus decay sets superseded_by = id ───────────────────────────

it.skipIf(skip)('G3-6: Ebbinghaus decay marks stale records with superseded_by = id', async () => {
  const { MemorySynthesizerWorker } = await import('./synthesizer.worker.js');

  const scopeId = randomUUID();

  const insertResult = await pool.query<{ id: string }>(
    `INSERT INTO procedural_memory
       (scope_id, content, reinforcement_count, last_used_at, created_at)
     VALUES ($1, $2, 0, NOW() - INTERVAL '91 days', NOW())
     RETURNING id`,
    [scopeId, 'Stale procedure for G3-6'],
  );
  const staleId = insertResult.rows[0]?.id;
  expect(staleId).toBeDefined();

  const mockLlm = { chat: async () => '' };
  const worker = new MemorySynthesizerWorker(new PoolTrailReader(pool), pool, mockLlm as never);
  await worker.runDecay();

  const { rows } = await pool.query<{ superseded_by: string }>(
    `SELECT superseded_by FROM procedural_memory WHERE id = $1`,
    [staleId],
  );
  expect(rows[0]?.superseded_by).toBe(staleId);
});

// ── G3-7: Gate 2 regression — health endpoint ────────────────────────────────

it.skipIf(skip)('G3-7: GET /v1/sys/health returns 200 (Gate 2 regression)', async () => {
  const { buildApp } = await import('@graph/gateway/index.js');

  const app = buildApp(pool, pool, 4096);
  const res = await app.fetch(new Request('http://localhost/v1/sys/health'));
  expect(res.status).toBe(200);
});
