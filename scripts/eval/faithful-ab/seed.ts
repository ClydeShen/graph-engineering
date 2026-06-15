/**
 * Golden-template seeder for the microservice-DAG A/B arm. Direct-seeds the
 * learned runbook so injection recall has the shortcut to find (isolates the
 * injection->efficiency link; the learning-curve experiment instead lets
 * crystallization produce templates from real converged runs).
 */
import type { Pool } from 'pg';
import type { EmbeddingProvider } from '@graph/shared';
import { PoolMemoryRepository } from '@graph/workers/base/memory-repository';
import { buildTemplateGraphFromEvents, canonicalizeTemplateGraph, type TemplateGraph } from '@graph/workers/memory/template-graph';
import { computeWLEmbedding } from '@graph/workers/memory/wl-embedding';
import { GOLDEN_INTENT, GOLDEN_ORDER } from './dag.js';

export const GOLDEN_SENTINEL = '00000000-0000-4000-8000-0000000da901';

function wlLiteral(graph: TemplateGraph): string {
  const e = computeWLEmbedding(
    graph.nodes.map((n) => ({ id: n.id, event_type: n.label })),
    graph.edges.map((x) => ({ source: x.from, target: x.to })),
  );
  return '[' + Array.from(e).join(',') + ']';
}

function syntheticEvents(): { version_hash: string; predecessor_hash: string; event_type: string }[] {
  const evs = [{ version_hash: 'h-plan', predecessor_hash: '0'.repeat(64), event_type: 'plan_created' }];
  let prev = 'h-plan';
  GOLDEN_ORDER.forEach((_s, i) => {
    evs.push({ version_hash: `h-s${i}`, predecessor_hash: prev, event_type: 'task_spawned' });
    evs.push({ version_hash: `h-d${i}`, predecessor_hash: `h-s${i}`, event_type: 'memory_updated' });
    prev = `h-d${i}`;
  });
  return evs;
}

export async function seedGoldenTemplate(pool: Pool, embed: EmbeddingProvider | null): Promise<{ id: string }> {
  await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id = $1`, [GOLDEN_SENTINEL]);
  const skeleton = canonicalizeTemplateGraph(buildTemplateGraphFromEvents(syntheticEvents()));
  let intentEmbeddingLiteral: string | null = null;
  if (embed) {
    const { vector } = await embed.embed(GOLDEN_INTENT);
    intentEmbeddingLiteral = '[' + vector.join(',') + ']';
  }
  const memory = new PoolMemoryRepository(pool);
  return memory.insertProceduralTemplate({
    scopeId: GOLDEN_SENTINEL,
    content: GOLDEN_INTENT,
    intentDescription: GOLDEN_INTENT,
    templateGraph: skeleton,
    embeddingLiteral: wlLiteral(skeleton),
    intentEmbeddingLiteral,
    isAntiPattern: false,
  });
}
