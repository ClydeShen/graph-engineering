/**
 * Cross-channel identity unification (ADR-46 D-5, Phase 13).
 *
 * principal_alias (migration 015) is the O(1) lookup projection; the graph
 * carries the memex::identity::same_as audit events (SSOT audit face). Humans
 * and agents share the principal model: 'user:alice', 'agent:coder-1', and
 * channel-prefixed aliases all resolve through here.
 */

import type { Pool } from 'pg';
import { canonicalJson, writeInfraEvent } from '@graph/shared';
import type { ChannelPrefixedSenderId } from '@graph/types/connector';

export const IDENTITY_SCOPE_INTENT = 'identity:registry';

/** Resolve a channel-prefixed sender to its unified principal (or itself). */
export async function resolvePrincipal(pool: Pool, senderId: string): Promise<string> {
  const { rows } = await pool.query<{ principal: string }>(
    `SELECT principal FROM principal_alias WHERE alias = $1`,
    [senderId],
  );
  return rows.length > 0 ? rows[0]!.principal : senderId;
}

/**
 * Establish a same_as alias (explicit, user/admin-initiated — automatic
 * suggestion via Trail Discovery is post-1.0). Writes the projection row and
 * the audit event.
 */
export async function addSameAsAlias(
  pool: Pool,
  identityScopeId: string,
  alias: ChannelPrefixedSenderId,
  principal: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO principal_alias (alias, principal)
     VALUES ($1, $2)
     ON CONFLICT (alias) DO UPDATE SET principal = EXCLUDED.principal`,
    [alias, principal],
  );
  await writeInfraEvent(
    pool,
    identityScopeId,
    'memory_updated',
    canonicalJson({
      kind: 'memex::identity::same_as',
      alias,
      principal,
      at: new Date().toISOString(),
    }),
    'archived',
  );
}
