/**
 * CrossScopePatternDiscoveryWorker — cross-domain cluster assignment.
 *
 * Discovers `procedural_memory` template pairs that are topologically similar
 * (topology_embedding cosine > 0.90, i.e. distance < 0.10) but semantically
 * different (intent_embedding distance > 0.50). Connected pairs are grouped into
 * shared clusters via union-find and persisted as `cross_domain_cluster_id`.
 *
 * Thresholds (Claude's discretion per CONTEXT.md §"Claude's Discretion"):
 *   - Topology cosine threshold: 0.90  (distance < 0.10) — high structural similarity
 *   - Intent distance threshold:  0.50 — ensures cross-domain guard (different semantics)
 *
 * @see ADR 25 — WL graph kernel algorithm + CrossScopePatternDiscovery SQL spec
 * @see ADR 37 — cron-only schedule, corpus guard, no OLTP slot acquisition
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

// ── Union-find (pure, no DB) ──────────────────────────────────────────────────

/**
 * Assigns shared cluster UUIDs to connected components formed by the given pairs.
 *
 * Pure function — no database access. Usable in unit tests without a DB.
 *
 * @param pairs - Array of [id_a, id_b] edges representing topologically-similar,
 *   semantically-different template pairs.
 * @returns Map<template_id, cluster_uuid> — every id in a connected component
 *   maps to the same UUID; ids that appear in no pair are not included.
 *
 * @example
 * // Disjoint pairs → distinct cluster IDs
 * assignClusters([['a','b'], ['c','d']]) // a,b share one UUID; c,d share another
 *
 * @example
 * // Chain a-b, b-c → all three in the same cluster
 * assignClusters([['a','b'], ['b','c']]) // a,b,c share one UUID
 */
export function assignClusters(pairs: [string, string][]): Map<string, string> {
  const parent = new Map<string, string>();

  function find(id: string): string {
    if (!parent.has(id)) parent.set(id, id);
    if (parent.get(id) !== id) {
      // Path compression
      parent.set(id, find(parent.get(id)!));
    }
    return parent.get(id)!;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  // Ensure all IDs are registered, then union each pair
  for (const [a, b] of pairs) {
    find(a);
    find(b);
    union(a, b);
  }

  // Collect all distinct roots and assign one UUID per root
  const rootToCluster = new Map<string, string>();
  const result = new Map<string, string>();

  for (const id of parent.keys()) {
    const root = find(id);
    if (!rootToCluster.has(root)) {
      rootToCluster.set(root, randomUUID());
    }
    result.set(id, rootToCluster.get(root)!);
  }

  return result;
}

// ── DB-backed discovery ───────────────────────────────────────────────────────

/**
 * Discovers cross-domain template clusters and writes `cross_domain_cluster_id`
 * to `procedural_memory` for each matched pair.
 *
 * Algorithm (ADR 25 Phase 2 spec):
 *  1. SELECT all un-clustered templates with both embeddings populated and
 *     is_anti_pattern = FALSE (Pitfall 6: partial HNSW index guard).
 *  2. For each template, run a per-row ANN search (ORDER BY topology_embedding <=> $1 LIMIT 50)
 *     with topology distance < 0.10 AND intent distance > 0.50 (Pitfall 1: HNSW only fires
 *     on ORDER BY + LIMIT form, not on arbitrary JOIN filters).
 *  3. Collect (source_id, neighbor_id) pairs and run assignClusters (union-find).
 *  4. UPDATE procedural_memory SET cross_domain_cluster_id = $1 WHERE id = $2
 *     AND cross_domain_cluster_id IS NULL  (Pitfall 5: idempotent guard).
 *
 * @param pool - pg Pool for direct SQL access (no GraphHandle, no OCC write — ADR 37).
 * @param topologyCosineThreshold - cosine similarity threshold; default 0.90
 *   (topology distance threshold = 1 - 0.90 = 0.10).
 * @param intentDistanceThreshold - minimum intent distance to qualify as cross-domain;
 *   default 0.50.
 * @returns void — side effects only (DB updates).
 */
export async function discoverClusters(
  pool: Pool,
  topologyCosineThreshold = 0.90,
  intentDistanceThreshold = 0.50,
): Promise<void> {
  const topologyDistanceLimit = 1 - topologyCosineThreshold; // 0.10 for default 0.90

  // Step 1: fetch all un-clustered, non-anti-pattern templates with both embeddings.
  // cross_domain_cluster_id IS NULL ensures we skip already-assigned rows.
  // is_anti_pattern = FALSE on both the candidate query and the neighbor query
  // mirrors the partial HNSW index (Pitfall 6).
  const { rows: candidates } = await pool.query<{
    id: string;
    topology_embedding: string;
    intent_embedding: string;
  }>(
    `SELECT id, topology_embedding, intent_embedding
     FROM procedural_memory
     WHERE topology_embedding IS NOT NULL
       AND intent_embedding IS NOT NULL
       AND is_anti_pattern = FALSE
       AND cross_domain_cluster_id IS NULL`,
  );

  if (candidates.length === 0) return;

  // Step 2: for each candidate, find neighbors via per-row HNSW ANN search.
  // Using ORDER BY topology_embedding <=> $1 LIMIT 50 is the form that triggers
  // the HNSW index (Pitfall 1 — arbitrary JOIN with <=> does not use HNSW).
  const pairs: [string, string][] = [];

  for (const row of candidates) {
    const { rows: neighbors } = await pool.query<{ id: string }>(
      `SELECT id
       FROM procedural_memory
       WHERE topology_embedding IS NOT NULL
         AND intent_embedding IS NOT NULL
         AND is_anti_pattern = FALSE
         AND id != $2::uuid
         AND topology_embedding <=> $1 < $3
         AND intent_embedding <=> $4 > $5
       ORDER BY topology_embedding <=> $1
       LIMIT 50`,
      [
        row.topology_embedding,
        row.id,
        topologyDistanceLimit,
        row.intent_embedding,
        intentDistanceThreshold,
      ],
    );

    for (const neighbor of neighbors) {
      pairs.push([row.id, neighbor.id]);
    }
  }

  if (pairs.length === 0) return;

  // Step 3: union-find over collected pairs to assign cluster IDs.
  const assignments = assignClusters(pairs);

  // Step 4: persist cluster assignments idempotently.
  // WHERE cross_domain_cluster_id IS NULL prevents overwriting existing assignments
  // on re-run (Pitfall 5 — idempotency guard).
  for (const [id, clusterId] of assignments) {
    await pool.query(
      `UPDATE procedural_memory
       SET cross_domain_cluster_id = $1
       WHERE id = $2 AND cross_domain_cluster_id IS NULL`,
      [clusterId, id],
    );
  }
}
