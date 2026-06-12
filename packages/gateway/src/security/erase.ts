/**
 * erase(scope) — right-to-erasure workflow (ADR-43 / ADR-47 D-1).
 *
 * Structure permanent, content erasable: payload blanking + erased_at on the
 * ledger (verification semantics per ADR-43 D-3: content re-verification
 * skipped for erased rows, predecessor-chain verification unaffected,
 * version_hash retained as a commitment), derived-data cascade per ADR-43 D-4,
 * DEK destruction marker for the Phase 15 backup coupling, and a
 * memex::security::payload_erase audit event that carries NO erased content.
 */

import type { Pool } from 'pg';
import { canonicalJson, eraseArtifactsForScope, writeInfraEvent } from '@graph/shared';

export interface EraseResult {
  ledger_rows_erased: number;
  episodic_deleted: number;
  semantic_deleted: number;
  procedural_deleted: number;
  lessons_flagged_redistill: number;
  dek_destroyed: boolean;
  artifacts_erased: number;
}

export async function eraseScope(
  pool: Pool,
  scopeId: string,
  requestedBy: string,
  reason: 'user_request' | 'retention_policy' | 'admin',
): Promise<EraseResult> {
  // 1. Ledger: blank payloads + erased_at. Hash/chain/topology untouched (D-1/D-3).
  const ledger = await pool.query(
    `UPDATE execution_event_log
     SET payload = '', erased_at = NOW()
     WHERE scope_id = $1 AND erased_at IS NULL`,
    [scopeId],
  );

  // 2. Derived-data cascade (ADR-43 D-4): single-source rows physically deleted
  //    WITH their embeddings (vectors are PII — they invert to content).
  const episodic = await pool.query(
    `DELETE FROM episodic_memory WHERE source_scope_id = $1`,
    [scopeId],
  );
  const semantic = await pool.query(
    `DELETE FROM semantic_memory WHERE source_scope_id = $1`,
    [scopeId],
  );
  // Procedural: fingerprint Lessons may aggregate multiple scopes — those are
  // flagged needs_redistill instead of deleted (next reinforcement re-distills
  // from surviving sources); plain single-source templates are deleted.
  const procedural = await pool.query(
    `DELETE FROM procedural_memory
     WHERE source_scope_id = $1 AND fingerprint_id IS NULL`,
    [scopeId],
  );
  const lessons = await pool.query(
    `UPDATE procedural_memory
     SET needs_redistill = TRUE, source_scope_id = NULL
     WHERE source_scope_id = $1 AND fingerprint_id IS NOT NULL`,
    [scopeId],
  );

  // 2.5 Artifact cascade (ADR-52): provenance rows erased + orphaned disk
  //     content unlinked. Table may predate migration 018 — treat as zero.
  let artifactsErased = 0;
  try {
    artifactsErased = (await eraseArtifactsForScope(pool, scopeId)).rows_erased;
  } catch {
    /* migration 018 not applied — no artifacts to erase */
  }

  // 3. DEK destruction marker (Phase 15 backup coupling reads this).
  const dek = await pool.query(
    `UPDATE key_registry SET destroyed_at = NOW(), wrapped_dek = NULL
     WHERE scope_id = $1 AND destroyed_at IS NULL`,
    [scopeId],
  );

  // 4. Audit — scope_id, principal, reason ONLY; never erased content (D-5).
  await writeInfraEvent(
    pool,
    scopeId,
    'memory_updated',
    canonicalJson({
      kind: 'memex::security::payload_erase',
      requested_by: requestedBy,
      reason,
      at: new Date().toISOString(),
    }),
    'archived',
  );

  return {
    ledger_rows_erased: ledger.rowCount ?? 0,
    episodic_deleted: episodic.rowCount ?? 0,
    semantic_deleted: semantic.rowCount ?? 0,
    procedural_deleted: procedural.rowCount ?? 0,
    lessons_flagged_redistill: lessons.rowCount ?? 0,
    dek_destroyed: (dek.rowCount ?? 0) > 0,
    artifacts_erased: artifactsErased,
  };
}
