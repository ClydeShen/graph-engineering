import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { occWrite } from '@graph/shared';

const ZERO_HASH = '0'.repeat(64);

export async function dispatchMessage(
  sessionKey: string,
  text: string,
  pool: Pool,
  sourceMessageId: string,
): Promise<string> {
  const taskId = randomUUID();
  // Each gateway message creates its own scope. Production deployments should
  // pre-create per-session scopes via nestScope() and pass the stable scope ID here.
  const scopeId = randomUUID();
  await occWrite(pool, {
    scopeId,
    entityId: randomUUID(),
    predecessorHash: ZERO_HASH,
    eventType: 'task_spawned',
    payload: {
      task_id: taskId,
      source: sessionKey,
      text,
      required_skills: ['message-handler'],
      source_message_id: sourceMessageId,
    },
  });
  return taskId;
}
