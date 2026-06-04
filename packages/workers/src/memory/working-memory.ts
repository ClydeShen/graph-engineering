import { createHash } from 'crypto';
import type { Pool } from 'pg';
import { writeGuard } from '@graph/shared';

export async function insertWorkingMemory(
  pool: Pool,
  scopeId: string,
  entityId: string,
  eventType: string,
  content: string,
): Promise<{ inserted: boolean }> {
  const payloadHash = createHash('sha256').update(content).digest('hex');
  const dedupHash = createHash('sha256')
    .update(`${scopeId}|${entityId}|${eventType}|${payloadHash}`)
    .digest('hex');

  const { rows } = await pool.query(
    `SELECT id FROM working_memory WHERE scope_id = $1 AND dedup_hash = $2 AND created_at > NOW() - INTERVAL '5 minutes'`,
    [scopeId, dedupHash],
  );

  if (rows.length > 0) return { inserted: false };

  await pool.query(
    `INSERT INTO working_memory (scope_id, content, dedup_hash, created_at) VALUES ($1, $2, $3, NOW())`,
    [scopeId, writeGuard(content), dedupHash],
  );

  return { inserted: true };
}
