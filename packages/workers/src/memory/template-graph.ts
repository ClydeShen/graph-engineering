/**
 * Template Graph — canonical structured skeleton format (TD-C, ADR-25 supplement 2).
 *
 * A TemplateGraph is the machine-comparable edge-list representation of an
 * execution Scope's topology. Two isomorphic Scope DAGs (different UUIDs, same
 * structure) MUST canonicalize to identical JSON — this is the property that
 * makes Trail Discovery hit-rate measurable (Phase 16 eval).
 *
 * Abstraction level "interface-edge": node labels are event_type strings only;
 * payload semantics are deliberately excluded (topology over content, ADR 25).
 * Consecutive same-label linear runs are collapsed so the skeleton captures
 * type *transitions*, not event counts.
 *
 * @see docs/adr/0050-adr25-supplement2-template-graph-schema.md
 */

import { createHash } from 'crypto';

export interface TemplateGraphNode {
  id: string;
  /** event_type label — the only node semantic that survives abstraction. */
  label: string;
}

export interface TemplateGraphEdge {
  from: string;
  to: string;
}

export interface TemplateGraph {
  version: 1;
  abstraction: 'interface-edge';
  nodes: TemplateGraphNode[];
  edges: TemplateGraphEdge[];
  /**
   * Anti-pattern rows only (success-correlation negatives): confidence that the
   * failure→fix causal pairing is real. Injection paths skip 'low' rows.
   */
  correlation_confidence?: 'high' | 'low';
}

/** Minimal event shape needed to build a template graph from a Scope DAG. */
export interface TemplateGraphSourceEvent {
  version_hash: string;
  predecessor_hash: string;
  event_type: string;
}

function sha(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Build a raw template graph from Scope events: one node per event labeled by
 * event_type, one edge per predecessor link that resolves within the Scope,
 * then collapse consecutive same-label linear runs.
 */
export function buildTemplateGraphFromEvents(
  events: TemplateGraphSourceEvent[],
): TemplateGraph {
  const byHash = new Map(events.map((e) => [e.version_hash, e]));
  const nodes: TemplateGraphNode[] = events.map((e) => ({
    id: e.version_hash,
    label: e.event_type,
  }));
  const edges: TemplateGraphEdge[] = events
    .filter((e) => byHash.has(e.predecessor_hash))
    .map((e) => ({ from: e.predecessor_hash, to: e.version_hash }));

  return collapseLinearRuns({ version: 1, abstraction: 'interface-edge', nodes, edges });
}

/**
 * Collapse linear runs of identical labels: merge edge u→v into u when
 * label(u) === label(v), out-degree(u) === 1 and in-degree(v) === 1.
 * Repeats until fixpoint. 5×memory_updated in a row becomes 1 node — the
 * skeleton records that a memory_updated phase happened, not how long it was.
 */
export function collapseLinearRuns(graph: TemplateGraph): TemplateGraph {
  const label = new Map(graph.nodes.map((n) => [n.id, n.label]));
  // adjacency as mutable sets
  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    out.set(n.id, new Set());
    inn.set(n.id, new Set());
  }
  for (const e of graph.edges) {
    out.get(e.from)?.add(e.to);
    inn.get(e.to)?.add(e.from);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [u, outs] of out) {
      if (outs.size !== 1) continue;
      const v = [...outs][0]!;
      if (u === v) continue;
      if (label.get(u) !== label.get(v)) continue;
      if ((inn.get(v)?.size ?? 0) !== 1) continue;
      // merge v into u: u absorbs v's out-edges
      outs.delete(v);
      for (const w of out.get(v) ?? []) {
        if (w !== u) {
          outs.add(w);
          inn.get(w)?.delete(v);
          inn.get(w)?.add(u);
        }
      }
      out.delete(v);
      inn.delete(v);
      label.delete(v);
      changed = true;
      break; // restart iteration — maps were mutated
    }
  }

  const nodes = [...label.entries()].map(([id, l]) => ({ id, label: l }));
  const edges: TemplateGraphEdge[] = [];
  for (const [from, tos] of out) {
    for (const to of tos) edges.push({ from, to });
  }
  return { ...graph, nodes, edges };
}

/**
 * Canonicalize: WL-style label refinement (3 rounds, both edge directions) orders
 * nodes structurally; canonical ids n0..nK are assigned in refined-label order so
 * the serialized form is independent of original UUIDs and input order.
 *
 * Known boundary: WL refinement cannot distinguish certain symmetric node pairs
 * (Weisfeiler-Lehman indistinguishability). For truly automorphic nodes any
 * assignment yields the same edge set, so canonical equality still holds; exotic
 * WL-equivalent-but-non-automorphic graphs may canonicalize unequally — accepted,
 * execution DAGs do not exhibit these in practice (ADR-25 supplement 2).
 */
export function canonicalizeTemplateGraph(graph: TemplateGraph): TemplateGraph {
  const ids = graph.nodes.map((n) => n.id);
  const baseLabel = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const inNbrs = new Map<string, string[]>(ids.map((id) => [id, []]));
  const outNbrs = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of graph.edges) {
    inNbrs.get(e.to)?.push(e.from);
    outNbrs.get(e.from)?.push(e.to);
  }

  let refined = new Map(baseLabel);
  for (let round = 0; round < 3; round++) {
    const next = new Map<string, string>();
    for (const id of ids) {
      const inL = (inNbrs.get(id) ?? []).map((n) => refined.get(n)!).sort();
      const outL = (outNbrs.get(id) ?? []).map((n) => refined.get(n)!).sort();
      next.set(id, sha(`${refined.get(id)}|in:${inL.join(',')}|out:${outL.join(',')}`));
    }
    refined = next;
  }

  // Sort by (original label, refined label) — original label keeps output readable,
  // refined label provides the structural ordering.
  const sortKey = new Map(
    ids.map((id) => [id, `${baseLabel.get(id)}#${refined.get(id)}`]),
  );
  const ordered = [...ids].sort((a, b) =>
    sortKey.get(a)! < sortKey.get(b)! ? -1 : sortKey.get(a)! > sortKey.get(b)! ? 1 : 0,
  );
  const canonical = new Map(ordered.map((id, i) => [id, `n${i}`]));

  const nodes = ordered.map((id) => ({ id: canonical.get(id)!, label: baseLabel.get(id)! }));
  const edges = graph.edges
    .map((e) => ({ from: canonical.get(e.from)!, to: canonical.get(e.to)! }))
    .sort((a, b) => (a.from + '>' + a.to < b.from + '>' + b.to ? -1 : 1));

  const result: TemplateGraph = { version: 1, abstraction: 'interface-edge', nodes, edges };
  if (graph.correlation_confidence !== undefined) {
    result.correlation_confidence = graph.correlation_confidence;
  }
  return result;
}

/** Machine comparison: canonical forms serialize identically iff graphs are equivalent. */
export function templateGraphsEquivalent(a: TemplateGraph, b: TemplateGraph): boolean {
  return (
    JSON.stringify(canonicalizeTemplateGraph(a)) ===
    JSON.stringify(canonicalizeTemplateGraph(b))
  );
}
