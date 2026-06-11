import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { occWrite } from '@graph/shared';
import { resolveSessionScope } from './session-scope.js';

export async function dispatchMessage(
  sessionKey: string,
  text: string,
  pool: Pool,
  sourceMessageId: string,
): Promise<string> {
  const taskId = randomUUID();
  // TD-E (Phase 11): stable session→scope mapping stored in the graph.
  // Same sessionKey → same scope while live; context accumulates in the Trail
  // and Knapsack assembles it. Idle timeout rolls to a fresh scope.
  const { scopeId, predecessorHash } = await resolveSessionScope(pool, sessionKey);
  await occWrite(pool, {
    scopeId,
    entityId: randomUUID(),
    predecessorHash,
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
