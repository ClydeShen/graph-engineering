/**
 * Infrastructure event writes — scope_closed and other infra-write rights.
 *
 * Promoted from packages/gateway/src/watchdog-sql.ts (Phase 11) so gateway and
 * gateway-bot share one implementation: appends an infra event to the scope's
 * Association chain (tip lookup + pgcrypto hash in one INSERT...SELECT) and
 * updates scope_lineage. Hash formula is the standard
 * scope_id|entity_id|predecessor_hash|event_type|payload (ADR 02).
 *
 * Infra writes bypass the EVENT_TYPES bus enum on purpose — they are
 * Gateway/Control-Plane rights (ADR 24), not agent-submitted events.
 */

import { randomUUID } from 'crypto';
import type { Pool } from 'pg';

export async function writeInfraEvent(
  pool: Pool,
  scopeId: string,
  eventType: string,
  canonicalPayload: string,
  scopeStatus: string,
): Promise<void> {
  const entityId = randomUUID();

  await pool.query(
    `INSERT INTO execution_event_log
       (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
     SELECT
       $1::uuid,
       $2::uuid,
       $3,
       version_hash,
       encode(
         digest(
           $1::text || '|' || $2::text || '|' || version_hash
             || '|' || $3 || '|' || $4,
           'sha256'
         ),
         'hex'
       ),
       $4,
       $5
     FROM execution_event_log
     WHERE scope_id = $1
     ORDER BY id DESC
     LIMIT 1`,
    [scopeId, entityId, eventType, canonicalPayload, scopeStatus],
  );

  await pool.query(
    `UPDATE scope_lineage SET status = $2 WHERE scope_id = $1`,
    [scopeId, scopeStatus === 'terminated' ? 'closed' : scopeStatus],
  );
}
