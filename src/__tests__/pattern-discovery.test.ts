import { describe, it, expect, vi } from 'vitest';
import {
  PatternDiscoveryWorker,
  PATTERN_DISCOVERY_CRON_TRIGGER,
} from '../../packages/workers/src/patterns/discover.worker.js';

function makePool(count: number) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ count }] }),
  } as unknown as import('pg').Pool;
}

describe('PatternDiscoveryWorker', () => {
  it('skips when completed_scope_count < MIN_CORPUS_THRESHOLD (count=9)', async () => {
    const worker = new PatternDiscoveryWorker();
    const result = await worker.runDiscovery(makePool(9));
    expect(result.skipped).toBe(true);
  });

  it('runs when completed_scope_count >= MIN_CORPUS_THRESHOLD (count=10)', async () => {
    const worker = new PatternDiscoveryWorker();
    const result = await worker.runDiscovery(makePool(10));
    expect(result.skipped).toBe(false);
  });

  it('has base_priority === 1', () => {
    expect(new PatternDiscoveryWorker().base_priority).toBe(1);
  });

  it('PATTERN_DISCOVERY_CRON_TRIGGER has correct cron expression and function_id', () => {
    expect(PATTERN_DISCOVERY_CRON_TRIGGER.config.expression).toBe('0 0 */6 * * * *');
    expect(PATTERN_DISCOVERY_CRON_TRIGGER.function_id).toBe('graph::patterns::discover');
    expect(PATTERN_DISCOVERY_CRON_TRIGGER.type).toBe('cron');
  });
});
