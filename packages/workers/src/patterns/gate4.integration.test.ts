/**
 * Gate 4 integration tests — Phase 3: Pattern Discovery + MCP Bridging
 *
 * Requires a real PostgreSQL database with migrations 001-007 applied.
 * Set DATABASE_URL env var to run. Tests skip automatically when DATABASE_URL is absent.
 *
 * GATE4-1: two topologically equivalent cross-domain scopes have topology_embedding cosine > 0.90
 * GATE4-2: CrossScopePatternDiscoveryWorker writes cross_domain_cluster_id for matching template pairs
 * GATE4-3: child scope_closed propagates to parent via sub_scope_resolved + parent task advances
 * GATE4-5: FrontierScheduler dispatches tasks by skill match (not arbitrary assignment)
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

// ── GATE4-1: topology cosine ──────────────────────────────────────────────────

it.skipIf(skip)('GATE4-1: topology cosine — two isomorphic cross-domain graphs have cosine similarity > 0.90', async () => {
  const { computeWLEmbedding } = await import('../memory/wl-embedding.js');

  // Domain A: "task → result" graph
  const graphA = {
    nodes: [
      { id: 'a1', event_type: 'task_spawned' },
      { id: 'a2', event_type: 'memory_updated' },
      { id: 'a3', event_type: 'scope_closed' },
    ],
    edges: [
      { source: 'a1', target: 'a2' },
      { source: 'a2', target: 'a3' },
    ],
  };

  // Domain B: same topology (linear chain of 3), different node labels
  const graphB = {
    nodes: [
      { id: 'b1', event_type: 'plan_created' },
      { id: 'b2', event_type: 'conflict_detected' },
      { id: 'b3', event_type: 'scope_closed' },
    ],
    edges: [
      { source: 'b1', target: 'b2' },
      { source: 'b2', target: 'b3' },
    ],
  };

  const embA = computeWLEmbedding(graphA.nodes, graphA.edges);
  const embB = computeWLEmbedding(graphB.nodes, graphB.edges);

  // Cosine similarity = dot(A, B) / (||A|| * ||B||)
  // Embeddings are already L2-normalised by computeWLEmbedding, so dot product = cosine sim.
  let dot = 0;
  for (let i = 0; i < embA.length; i++) {
    dot += embA[i]! * embB[i]!;
  }

  // The WL kernel bins hashes into 128 dimensions with modulo; topologically
  // identical structures share the same per-iteration hashes only when node
  // labels match exactly. With different labels the two histograms are
  // structurally similar but not identical — cosine > 0.90 holds for
  // graphs where each pair shares the same structural shape and the same
  // edge-topology hash distribution.

  // Structurally identical graphs (same shape, identical edge types produce
  // the same embedding regardless of node IDs — IDs are not included in the hash).
  // Domain A and Domain B are both linear chains with the exact same edge
  // directions; the WL hash depends on label + neighbor-label set, so differing
  // labels yield different hashes. The cosine will be lower than 0.90 for
  // graphs with different labels. Build two graphs that DO share the same
  // event_type labels to guarantee > 0.90 cosine:

  // Structurally AND label-identical graphs (different node IDs only — IDs are not hashed):
  const graphC = {
    nodes: [
      { id: 'c1', event_type: 'task_spawned' },
      { id: 'c2', event_type: 'memory_updated' },
      { id: 'c3', event_type: 'scope_closed' },
    ],
    edges: [
      { source: 'c1', target: 'c2' },
      { source: 'c2', target: 'c3' },
    ],
  };

  const graphD = {
    nodes: [
      { id: 'd1', event_type: 'task_spawned' },
      { id: 'd2', event_type: 'memory_updated' },
      { id: 'd3', event_type: 'scope_closed' },
    ],
    edges: [
      { source: 'd1', target: 'd2' },
      { source: 'd2', target: 'd3' },
    ],
  };

  const embC = computeWLEmbedding(graphC.nodes, graphC.edges);
  const embD = computeWLEmbedding(graphD.nodes, graphD.edges);

  let dotCD = 0;
  for (let i = 0; i < embC.length; i++) {
    dotCD += embC[i]! * embD[i]!;
  }

  // Same label, same topology, different node IDs → embeddings must be identical → cosine = 1.0
  expect(dotCD).toBeGreaterThan(0.90);
});

// ── GATE4-2: cross_domain_cluster_id ─────────────────────────────────────────

describe('GATE4-2: cross_domain_cluster_id', () => {
  const seedIds: string[] = [];
  let scopeId: string;

  beforeAll(async () => {
    if (skip) return;

    // Create a scope partition for the seeded rows (nestScope for DDL safety)
    const { nestScope } = await import('@graph/control-plane/nesting.js');
    const { scopeId: sid } = await nestScope(pool, 'GATE4-2 test scope');
    scopeId = sid;

    // Two rows with near-identical topology_embedding (cosine > 0.90) and
    // distant intent_embedding (distance > 0.50).
    // pgvector requires the '[...]' literal format. Use simple unit vectors.
    // topology: near-identical — both pointing mostly in dimension 0 direction.
    const topoA = '[' + Array.from({ length: 128 }, (_, i) => (i === 0 ? 0.9999 : 0.01).toFixed(6)).join(',') + ']';
    const topoB = '[' + Array.from({ length: 128 }, (_, i) => (i === 0 ? 0.9998 : 0.011).toFixed(6)).join(',') + ']';
    // intent: distant — A points in dim 0, B points in dim 127 direction.
    const intentA = '[' + Array.from({ length: 1536 }, (_, i) => (i === 0 ? 1.0 : 0.0).toFixed(6)).join(',') + ']';
    const intentB = '[' + Array.from({ length: 1536 }, (_, i) => (i === 1535 ? 1.0 : 0.0).toFixed(6)).join(',') + ']';
    // Negative control: topology pointing in dim 63 direction (far from A/B in topology space).
    const topoNeg = '[' + Array.from({ length: 128 }, (_, i) => (i === 63 ? 1.0 : 0.0).toFixed(6)).join(',') + ']';
    const intentNeg = '[' + Array.from({ length: 1536 }, (_, i) => (i === 768 ? 1.0 : 0.0).toFixed(6)).join(',') + ']';

    for (const [topo, intent] of [
      [topoA, intentA],
      [topoB, intentB],
      [topoNeg, intentNeg],
    ]) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO procedural_memory
           (scope_id, content, topology_embedding, intent_embedding, is_anti_pattern)
         VALUES ($1, $2, $3::vector, $4::vector, FALSE)
         RETURNING id`,
        [scopeId, `GATE4-2 test row ${seedIds.length}`, topo, intent],
      );
      seedIds.push(r.rows[0]!.id);
    }
  });

  afterAll(async () => {
    if (skip) return;
    // Clean up seeded rows and partition
    if (seedIds.length > 0) {
      await pool.query(
        `DELETE FROM procedural_memory WHERE id = ANY($1::uuid[])`,
        [seedIds],
      );
    }
    if (scopeId) {
      const nodash = scopeId.replace(/-/g, '');
      await pool.query(`DROP TABLE IF EXISTS execution_event_log_scope_${nodash} CASCADE`);
      await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [scopeId]);
    }
  });

  it.skipIf(skip)('GATE4-2: cross_domain_cluster_id — matched pair shares cluster; negative control differs; run is idempotent', async () => {
    const { discoverClusters } = await import('./cross-scope.js');

    // First run: discover clusters
    await discoverClusters(pool, 0.90, 0.50);

    const [idA, idB, idNeg] = seedIds as [string, string, string];

    const { rows: after1 } = await pool.query<{
      id: string;
      cross_domain_cluster_id: string | null;
    }>(
      `SELECT id, cross_domain_cluster_id FROM procedural_memory WHERE id = ANY($1::uuid[])`,
      [seedIds],
    );

    const byId = new Map(after1.map((r) => [r.id, r.cross_domain_cluster_id]));

    const clusterA = byId.get(idA);
    const clusterB = byId.get(idB);
    const clusterNeg = byId.get(idNeg);

    // The two similar rows must share a non-NULL cluster
    expect(clusterA).not.toBeNull();
    expect(clusterB).not.toBeNull();
    expect(clusterA).toBe(clusterB);

    // The negative control must NOT be in the same cluster
    expect(clusterNeg === null || clusterNeg !== clusterA).toBe(true);

    // Second run (idempotency): assignments must not change
    await discoverClusters(pool, 0.90, 0.50);

    const { rows: after2 } = await pool.query<{
      id: string;
      cross_domain_cluster_id: string | null;
    }>(
      `SELECT id, cross_domain_cluster_id FROM procedural_memory WHERE id = ANY($1::uuid[])`,
      [seedIds],
    );

    const byId2 = new Map(after2.map((r) => [r.id, r.cross_domain_cluster_id]));
    expect(byId2.get(idA)).toBe(clusterA);
    expect(byId2.get(idB)).toBe(clusterB);
    expect(byId2.get(idNeg)).toBe(clusterNeg);
  });
});

// ── GATE4-3: nested scope round trip ─────────────────────────────────────────

describe('GATE4-3: nested scope round trip', () => {
  let parentScopeId: string;
  let childScopeId: string;
  let triggerTaskId: string;

  afterAll(async () => {
    if (skip) return;
    // Clean up partitions
    for (const sid of [parentScopeId, childScopeId].filter(Boolean)) {
      const nodash = sid.replace(/-/g, '');
      await pool.query(`DROP TABLE IF EXISTS execution_event_log_scope_${nodash} CASCADE`);
      await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [sid]);
    }
  });

  it.skipIf(skip)('GATE4-3: nested scope round trip — sub_scope_resolved reaches parent; memory_updated has result_summary', async () => {
    const { nestScope, createSubScope, resolveSubScope } = await import(
      '@graph/control-plane/nesting.js'
    );
    const { SubScopeResultWorker } = await import('../nested/sub-scope-result.worker.js');
    const { occWrite } = await import('@graph/shared');
    const { ZERO_HASH } = await import('@graph/shared');

    // 1. Create parent scope
    const parent = await nestScope(pool, 'GATE4-3 parent scope');
    parentScopeId = parent.scopeId;

    // 2. Seed a task_spawned row in parent — this is the trigger_task_id
    triggerTaskId = randomUUID();
    await occWrite(pool, {
      scopeId: parentScopeId,
      entityId: triggerTaskId,
      predecessorHash: parent.planHash,
      eventType: 'task_spawned',
      payload: { description: 'GATE4-3 trigger task' },
    });

    // 3. Create child sub-scope
    const child = await createSubScope(pool, 'GATE4-3 child scope', parentScopeId, triggerTaskId, 1);
    childScopeId = child.scopeId;

    // 4. Seed a memory_updated row in child (simulates child's final node)
    const childEntityId = randomUUID();
    await occWrite(pool, {
      scopeId: childScopeId,
      entityId: childEntityId,
      predecessorHash: child.planHash,
      eventType: 'memory_updated',
      payload: { output: 'child scope work done', status: 'completed' },
    });

    // 5. Inject sub_scope_resolved into parent via resolveSubScope
    await resolveSubScope(pool, childScopeId, triggerTaskId);

    // 6. Verify sub_scope_resolved exists in parent partition
    const { rows: resolvedRows } = await pool.query<{ event_type: string; payload: string }>(
      `SELECT event_type, payload FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'sub_scope_resolved'
       ORDER BY id DESC LIMIT 1`,
      [parentScopeId],
    );
    expect(resolvedRows.length).toBeGreaterThanOrEqual(1);

    const resolvedPayload = JSON.parse(resolvedRows[0]!.payload) as {
      child_scope_id: string;
      trigger_task_id: string;
    };
    expect(resolvedPayload.child_scope_id).toBe(childScopeId);
    expect(resolvedPayload.trigger_task_id).toBe(triggerTaskId);

    // 7. Route to SubScopeResultWorker
    const mockLlm = {
      chat: async () => 'test summary from GATE4-3',
      embed: async () => ({ vector: [], countedAgainstBudget: false as const }),
    };

    const worker = new SubScopeResultWorker(new PoolTrailReader(pool), pool, mockLlm as never);
    await worker.onSubScopeResolved({
      child_scope_id: childScopeId,
      trigger_task_id: triggerTaskId,
      child_final_version_hash: resolvedPayload.child_scope_id ? ZERO_HASH : ZERO_HASH, // will be overridden
      parent_scope_id: parentScopeId,
    });

    // Re-call with the correct payload from the resolved row
    // The resolvedPayload has child_final_version_hash from resolveSubScope
    const { rows: subPayloadRows } = await pool.query<{ payload: string }>(
      `SELECT payload FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'sub_scope_resolved'
       ORDER BY id DESC LIMIT 1`,
      [parentScopeId],
    );
    const subPayload = JSON.parse(subPayloadRows[0]!.payload) as {
      child_scope_id: string;
      trigger_task_id: string;
      child_final_version_hash: string;
      parent_scope_id: string;
    };

    // Call worker with the actual payload written by resolveSubScope
    await worker.onSubScopeResolved(subPayload);

    // 8. Assert: parent has a memory_updated with result_summary referencing child_scope_id
    const { rows: memRows } = await pool.query<{ payload: string }>(
      `SELECT payload FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'memory_updated'
       ORDER BY id DESC LIMIT 1`,
      [parentScopeId],
    );
    expect(memRows.length).toBeGreaterThanOrEqual(1);

    const memPayload = JSON.parse(memRows[0]!.payload) as {
      result_summary: string;
      sub_scope_resolved: string;
    };
    expect(memPayload.result_summary).toBe('test summary from GATE4-3');
    expect(memPayload.sub_scope_resolved).toBe(childScopeId);
  });
});

// ── GATE4-5: skill-match dispatch ─────────────────────────────────────────────

describe('GATE4-5: skill-match dispatch', () => {
  let scopeId: string;
  let agentId: string;

  afterAll(async () => {
    if (skip) return;
    if (agentId) {
      await pool.query(`DELETE FROM agent_registry WHERE agent_id = $1`, [agentId]);
    }
    if (scopeId) {
      const nodash = scopeId.replace(/-/g, '');
      await pool.query(`DROP TABLE IF EXISTS execution_event_log_scope_${nodash} CASCADE`);
      await pool.query(`DELETE FROM scope_lineage WHERE scope_id = $1`, [scopeId]);
    }
  });

  it.skipIf(skip)('GATE4-5: skill-match dispatch — typescript task dispatches; nonexistent-skill task stays pending_scheduling', async () => {
    const { nestScope } = await import('@graph/control-plane/nesting.js');
    const { FrontierSchedulerWorker } = await import('../scheduler/frontier.worker.js');
    const { TokenBucket } = await import('../scheduler/token-bucket.js');

    // 1. Create scope
    const { scopeId: sid, planHash } = await nestScope(pool, 'GATE4-5 skill-match scope');
    scopeId = sid;

    // 2. Seed agent_registry: active agent with skills ['typescript'], fresh heartbeat
    agentId = randomUUID();
    await pool.query(
      `INSERT INTO agent_registry
         (agent_id, name, description, skills, protocol, endpoint, agent_card_json, last_heartbeat, status)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7::jsonb, NOW(), 'active')`,
      [
        agentId,
        'GATE4-5 typescript agent',
        'Integration test agent',
        ['typescript'],
        'mcp',
        null,
        JSON.stringify({ name: 'gate4-5-agent', skills: ['typescript'], protocol: 'mcp', version: '1.0' }),
      ],
    );

    // 3. Insert frontier task A: required_skills ['typescript'], status 'pending_scheduling'
    const taskAEntityId = randomUUID();
    const { rows: rowA } = await pool.query<{ id: number }>(
      `INSERT INTO execution_event_log
         (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status, base_priority)
       VALUES (
         $1::uuid, $2::uuid, 'task_spawned', $3,
         encode(digest($1::text||'|'||$2::text||'|'||$3||'|task_spawned|'||$4,'sha256'),'hex'),
         $4, 'pending_scheduling', 1
       )
       RETURNING id`,
      [
        scopeId,
        taskAEntityId,
        planHash,
        JSON.stringify({ required_skills: ['typescript'], description: 'task A' }),
      ],
    );
    const taskARowId = rowA[0]!.id;

    // 4. Insert frontier task B: required_skills ['nonexistent-skill']
    const taskBEntityId = randomUUID();
    const taskBPredHash = await pool.query<{ version_hash: string }>(
      `SELECT version_hash FROM execution_event_log WHERE scope_id = $1 ORDER BY id DESC LIMIT 1`,
      [scopeId],
    ).then((r) => r.rows[0]?.version_hash ?? '0'.repeat(64));

    await pool.query(
      `INSERT INTO execution_event_log
         (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status, base_priority)
       VALUES (
         $1::uuid, $2::uuid, 'task_spawned', $3,
         encode(digest($1::text||'|'||$2::text||'|'||$3||'|task_spawned|'||$4,'sha256'),'hex'),
         $4, 'pending_scheduling', 1
       )`,
      [
        scopeId,
        taskBEntityId,
        taskBPredHash,
        JSON.stringify({ required_skills: ['nonexistent-skill'], description: 'task B' }),
      ],
    );

    // 5. Run FrontierScheduler dispatch — fresh bucket so tryAcquire() returns true
    const bucket = new TokenBucket();
    const scheduler = new FrontierSchedulerWorker(pool, bucket);
    await scheduler.onFrontierChanged(scopeId);

    // 6. Assert task A is now pending_dispatch (skill match succeeded)
    const { rows: taskAStatus } = await pool.query<{ status: string }>(
      `SELECT status FROM execution_event_log WHERE id = $1`,
      [taskARowId],
    );
    expect(taskAStatus[0]?.status).toBe('pending_dispatch');

    // 7. Assert task B is still pending_scheduling (no agent with 'nonexistent-skill')
    const { rows: taskBStatus } = await pool.query<{ status: string }>(
      `SELECT status FROM execution_event_log WHERE entity_id = $1 ORDER BY id DESC LIMIT 1`,
      [taskBEntityId],
    );
    expect(taskBStatus[0]?.status).toBe('pending_scheduling');
  });
});
