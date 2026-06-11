import { randomUUID } from 'crypto';
import { type EventWriter, type LLMProvider, SUB_SCOPE_TOPIC } from '@graph/shared';
import type { TrailReader } from '../base/trail-reader.js';

export const SUB_SCOPE_RESULT_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::scope::sub-scope-result',
  config: { topic: SUB_SCOPE_TOPIC },
} as const;

interface SubScopeResolvedPayload {
  child_scope_id: string;
  trigger_task_id: string;
  child_final_version_hash: string;
  parent_scope_id: string;
}

export class SubScopeResultWorker {
  constructor(
    private readonly reader: TrailReader,
    private readonly writes: EventWriter,
    private readonly llm: LLMProvider,
  ) {}

  async onSubScopeResolved(payload: SubScopeResolvedPayload): Promise<void> {
    const { child_scope_id, trigger_task_id, child_final_version_hash, parent_scope_id } = payload;

    // Step 1: Read child scope's final node by child_final_version_hash (ADR 23 §3 step 1)
    const childNode = await this.reader.getVersionByHash(child_scope_id, child_final_version_hash);

    // Step 3: Use parent's tail version_hash as predecessor.
    const parentPredecessorHash = await this.reader.getTailVersionHash(parent_scope_id);

    // Error path: child final node not found (T-03-06-01 backstop — do NOT throw)
    if (childNode === null) {
      await this.writes.write({
        scopeId: parent_scope_id,
        entityId: randomUUID(),
        predecessorHash: parentPredecessorHash,
        eventType: 'memory_updated',
        payload: {
          sub_scope_resolved: child_scope_id,
          result_summary: null,
          error: 'child_final_node_not_found',
        },
      });
      return;
    }

    // Step 2: LLM CALL — ADR 22 — synthesize result summary from child final node content
    const childContent = childNode.payload;
    const result_summary = await this.llm.chat([
      {
        role: 'system',
        content:
          'You are a result synthesizer. Given the final state of a completed sub-scope, ' +
          'produce one concise paragraph summarizing the outcome for the parent scope.',
      },
      { role: 'user', content: childContent },
    ]);

    // Step 4: write memory_updated to PARENT scope (ADR 23 §3 step 3)
    await this.writes.write({
      scopeId: parent_scope_id,
      entityId: randomUUID(),
      predecessorHash: parentPredecessorHash,
      eventType: 'memory_updated',
      payload: {
        sub_scope_resolved: child_scope_id,
        result_summary,
        child_final_version_hash,
      },
    });
  }
}
