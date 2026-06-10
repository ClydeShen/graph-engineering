import { describe, it, expect } from 'vitest';
import { Worker, type WorkerExecutionContext, type PipelineContext } from './worker.abstract.js';

/**
 * Minimal concrete Worker — implements only the 5 existing abstract ADR-27
 * hooks. Does NOT override any of the 4 new pipeline hooks, proving they
 * are non-abstract (no-op defaults).
 *
 * Exposes the protected pipeline hooks via public passthrough methods so
 * the test can invoke them directly.
 */
class MinimalWorker extends Worker {
  async onScheduled(_ctx: WorkerExecutionContext): Promise<void> {}
  async onRunning(_ctx: WorkerExecutionContext): Promise<void> {}
  async onCompleted(_ctx: WorkerExecutionContext): Promise<void> {}
  async onFailed(_ctx: WorkerExecutionContext, _error: Error): Promise<void> {}
  async onConflicted(_ctx: WorkerExecutionContext): Promise<void> {}

  callOnContextAssembled(ctx: Readonly<PipelineContext>): Promise<void> {
    return this.onContextAssembled(ctx);
  }

  callOnContextCompressed(ctx: Readonly<PipelineContext>): Promise<void> {
    return this.onContextCompressed(ctx);
  }

  callOnLLMCalled(ctx: Readonly<PipelineContext>): Promise<void> {
    return this.onLLMCalled(ctx);
  }

  callOnResultWritten(ctx: Readonly<PipelineContext>): Promise<void> {
    return this.onResultWritten(ctx);
  }
}

/**
 * Second concrete Worker — overrides onContextAssembled and onLLMCalled
 * with custom logic, proving override capability.
 */
class OverridingWorker extends Worker {
  readonly observed: string[] = [];

  async onScheduled(_ctx: WorkerExecutionContext): Promise<void> {}
  async onRunning(_ctx: WorkerExecutionContext): Promise<void> {}
  async onCompleted(_ctx: WorkerExecutionContext): Promise<void> {}
  async onFailed(_ctx: WorkerExecutionContext, _error: Error): Promise<void> {}
  async onConflicted(_ctx: WorkerExecutionContext): Promise<void> {}

  protected override async onContextAssembled(ctx: Readonly<PipelineContext>): Promise<void> {
    this.observed.push(`assembled:${ctx.scopeId}`);
  }

  protected override async onLLMCalled(ctx: Readonly<PipelineContext>): Promise<void> {
    this.observed.push(`llmCalled:${ctx.scopeId}`);
  }

  callOnContextAssembled(ctx: Readonly<PipelineContext>): Promise<void> {
    return this.onContextAssembled(ctx);
  }

  callOnLLMCalled(ctx: Readonly<PipelineContext>): Promise<void> {
    return this.onLLMCalled(ctx);
  }
}

const samplePipelineContext: PipelineContext = {
  scopeId: 'scope-1',
  wMax: 8000,
  tokensBefore: 100,
  tokensAfter: 80,
  ccrHashes: ['abc123'],
  droppedCount: 2,
};

describe('Worker pipeline observability hooks (Phase 08)', () => {
  it('Test 1: minimal subclass implementing only the 5 ADR-27 hooks compiles and instantiates', () => {
    const worker = new MinimalWorker();
    expect(worker).toBeInstanceOf(Worker);
  });

  it('Test 2: inherited pipeline hooks resolve to no-op undefined without throwing', async () => {
    const worker = new MinimalWorker();

    await expect(worker.callOnContextAssembled(samplePipelineContext)).resolves.toBeUndefined();
    await expect(worker.callOnContextCompressed(samplePipelineContext)).resolves.toBeUndefined();
    await expect(worker.callOnLLMCalled(samplePipelineContext)).resolves.toBeUndefined();
    await expect(worker.callOnResultWritten(samplePipelineContext)).resolves.toBeUndefined();
  });

  it('Test 3: subclass overriding onContextAssembled and onLLMCalled invokes the override', async () => {
    const worker = new OverridingWorker();

    await worker.callOnContextAssembled(samplePipelineContext);
    await worker.callOnLLMCalled(samplePipelineContext);

    expect(worker.observed).toEqual(['assembled:scope-1', 'llmCalled:scope-1']);
  });

  it('Test 4: PipelineContext object literal type-checks with the exact D-07 fields', () => {
    const ctx: PipelineContext = {
      scopeId: 'scope-1',
      wMax: 8000,
      tokensBefore: 100,
      tokensAfter: 80,
      ccrHashes: ['abc123'],
      droppedCount: 2,
    };

    expect(ctx.scopeId).toBe('scope-1');
    expect(ctx.ccrHashes).toEqual(['abc123']);
  });
});
