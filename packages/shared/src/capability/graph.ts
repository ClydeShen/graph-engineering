/**
 * Capability Graph writes (ADR-51 minimal increments, Phase 17).
 *
 * Capabilities (MCP servers, skills, connectors, presets) are first-class
 * graph citizens: install / surface changes are Associations in a well-known
 * singleton scope (intent `capability:registry`), mirroring the
 * `connector::config_updated` pattern. Config stays operational (transport,
 * env); the graph is the semantic authority for what exists and what its
 * tool surface is (ADR-51 D-1).
 *
 * Scope CREATION stays a control-plane right (ADR-35): the CLI ensures the
 * scope via nestScope; this module only finds it and appends. Callers that
 * find no scope skip recording (graceful — observation resumes once the
 * registry scope exists).
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { canonicalJson } from '../canonical-json.js';
import { writeInfraEvent } from '../infra-write.js';

/** Well-known scope intent anchoring capability history in the graph. */
export const CAPABILITY_SCOPE_INTENT = 'capability:registry';

/** Event payload kinds (memex:: prefix per CLAUDE.md naming for new surfaces). */
export const CAPABILITY_EVENT_KINDS = {
  installed: 'memex::capability::installed',
  uninstalled: 'memex::capability::uninstalled',
  configured: 'memex::capability::configured',
  surfaceChanged: 'memex::capability::surface_changed',
} as const;

export type CapabilityEventKind = keyof typeof CAPABILITY_EVENT_KINDS;

/**
 * Deterministic Tool Entity id for a registered invocable signature
 * (ADR-51 D-3: Tool Entity = registered signature; same server+tool always
 * maps to the same Entity across restarts so statistics accumulate).
 * sha256('mcp-tool|server|tool') truncated to UUID shape.
 */
export function toolEntityId(serverName: string, toolName: string): string {
  const h = createHash('sha256').update(`mcp-tool|${serverName}|${toolName}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Implementation Entity id for a capability package (same scheme, distinct namespace). */
export function implementationEntityId(name: string): string {
  const h = createHash('sha256').update(`capability-impl|${name}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Category Entity id (stable vocabulary node, ADR-51 D-2). */
export function categoryEntityId(category: string): string {
  const h = createHash('sha256').update(`capability-category|${category}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Bind a category to an implementation (ADR-51 D-1: binding is a Snapshot
 * chain in the graph — the ledger event is the authority, capability_binding
 * is the current-state read model updated in the same call).
 */
export async function bindCategory(
  pool: Pool,
  scopeId: string,
  category: string,
  implementation: string,
): Promise<void> {
  await writeInfraEvent(
    pool,
    scopeId,
    'memory_updated',
    canonicalJson({
      kind: 'memex::capability::bound',
      category,
      category_entity_id: categoryEntityId(category),
      implementation,
      implementation_entity_id: implementationEntityId(implementation),
      at: new Date().toISOString(),
    }),
    'archived',
  );
  await pool.query(
    `INSERT INTO capability_binding (category, implementation, bound_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (category) DO UPDATE SET implementation = $2, bound_at = NOW()`,
    [category, implementation],
  );
}

/** Current category→implementation bindings (read model; history is in the ledger). */
export async function resolveBindings(pool: Pool): Promise<Record<string, string>> {
  const res = await pool.query<{ category: string; implementation: string }>(
    `SELECT category, implementation FROM capability_binding`,
  );
  return Object.fromEntries(res.rows.map((r) => [r.category, r.implementation]));
}

/**
 * Record "implementation X was active in scope Y" (co-occurrence sampling,
 * ADR-51 D-6). Idempotent per (scope, implementation); outcome attribution
 * happens at query time via scope_lineage.
 */
export async function recordActivation(
  pool: Pool,
  scopeId: string,
  implementation: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO capability_activation (scope_id, implementation)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [scopeId, implementation],
  );
}

export interface CapabilityStat {
  implementation: string;
  activations: number;
  /** Scopes that converged (scope_lineage.status = 'closed') while this was active. */
  successes: number;
  last_used: string | null;
}

/**
 * Per-implementation co-occurrence stats (endorsement v1, ADR-51 D-5/D-6):
 * success = the scope converged. Ranking = successes desc, recency desc.
 * Switch-pair strong samples refine this in Phase 20.
 */
export async function capabilityStats(pool: Pool): Promise<CapabilityStat[]> {
  const res = await pool.query<{
    implementation: string;
    activations: string;
    successes: string;
    last_used: string | null;
  }>(
    `SELECT ca.implementation,
            COUNT(*)::text AS activations,
            COUNT(*) FILTER (WHERE sl.status = 'closed')::text AS successes,
            MAX(ca.activated_at)::text AS last_used
     FROM capability_activation ca
     LEFT JOIN scope_lineage sl ON sl.scope_id = ca.scope_id
     GROUP BY ca.implementation
     ORDER BY COUNT(*) FILTER (WHERE sl.status = 'closed') DESC, MAX(ca.activated_at) DESC`,
  );
  return res.rows.map((r) => ({
    implementation: r.implementation,
    activations: Number(r.activations),
    successes: Number(r.successes),
    last_used: r.last_used,
  }));
}

/**
 * Build the cold-start capability endorsement block (ADR-51 D-4/D-5 v1).
 * Compact by design (≤ ~10 lines): Level-1 metadata ranked by co-occurrence
 * stats — the agent keeps the choice, the system orders the evidence.
 * Returns null when there is nothing to say (no stats, no bindings).
 */
export async function buildCapabilityEndorsement(pool: Pool, topN = 8): Promise<string | null> {
  try {
    const [stats, bindings] = await Promise.all([capabilityStats(pool), resolveBindings(pool)]);
    if (stats.length === 0 && Object.keys(bindings).length === 0) return null;

    const lines: string[] = ['[capabilities]'];
    for (const [category, impl] of Object.entries(bindings)) {
      lines.push(`${category} -> ${impl} (bound)`);
    }
    for (const s of stats.slice(0, topN)) {
      const rate = s.activations > 0 ? `${s.successes}/${s.activations} converged` : 'unused';
      lines.push(`${s.implementation}: ${rate}${s.last_used ? `, last ${s.last_used.slice(0, 10)}` : ''}`);
    }
    return lines.join('\n');
  } catch {
    // capability tables absent (migration 017 not applied) — endorsement is optional
    return null;
  }
}

/** Locate the singleton capability registry scope; null when not yet created. */
export async function findCapabilityScope(pool: Pool): Promise<string | null> {
  const res = await pool.query<{ scope_id: string }>(
    `SELECT scope_id FROM scope_lineage WHERE intent = $1 ORDER BY created_at ASC LIMIT 1`,
    [CAPABILITY_SCOPE_INTENT],
  );
  return res.rows[0]?.scope_id ?? null;
}

/**
 * Append one capability event to the registry scope ('archived' status:
 * bookkeeping record, never moves scope lifecycle — same as connector config).
 * Payload must not contain secret VALUES — pass names/identifiers only.
 */
export async function recordCapabilityEvent(
  pool: Pool,
  scopeId: string,
  kind: CapabilityEventKind,
  detail: Record<string, unknown>,
): Promise<void> {
  await writeInfraEvent(
    pool,
    scopeId,
    'memory_updated',
    canonicalJson({
      kind: CAPABILITY_EVENT_KINDS[kind],
      ...detail,
      at: new Date().toISOString(),
    }),
    'archived',
  );
}
