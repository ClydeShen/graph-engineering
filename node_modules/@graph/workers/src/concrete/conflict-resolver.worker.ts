/**
 * ConflictResolverWorker — Phase 1 STUB.
 *
 * LLM-assisted merge is DEFERRED to Phase 2.
 * In Phase 1, the OCC Writable CTE (Plan 03) handles all conflicts deterministically:
 * the first writer wins and the second writer receives occ_result='demoted' with its
 * predecessor_hash rewritten to point to the winner — NO application callback needed.
 *
 * This stub logs the conflict and no-ops so the lifecycle completes cleanly.
 *
 * @see ADR 11 — OCC hard-stop (causal inversion, no retry)
 * @see ADR 27 — Worker lifecycle (onConflicted path)
 */

import { Worker, type WorkerExecutionContext } from '../base/worker.abstract.js';

export class ConflictResolverWorker extends Worker {
  async onScheduled(_ctx: WorkerExecutionContext): Promise<void> {}

  async onRunning(_ctx: WorkerExecutionContext): Promise<void> {
    // Phase 1: OCC Writable CTE resolves conflicts deterministically.
    // No LLM call here — LLM-assisted merge is Phase 2.
  }

  async onCompleted(_ctx: WorkerExecutionContext): Promise<void> {}

  async onFailed(_ctx: WorkerExecutionContext, _error: Error): Promise<void> {}

  async onConflicted(_ctx: WorkerExecutionContext): Promise<void> {
    // Phase 1: no-op. OCC causal inversion already resolved the conflict in DB.
    // Phase 2 will add LLM-assisted semantic merge here.
  }
}
