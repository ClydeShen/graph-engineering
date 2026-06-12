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
