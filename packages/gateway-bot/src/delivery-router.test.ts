/**
 * delivery-router.test.ts — Phase 12 DoD G4: five target syntaxes,
 * silence suppression, retry-then-record failure policy.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

const mockWriteInfraEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('@graph/shared', () => ({
  writeInfraEvent: (...a: unknown[]) => mockWriteInfraEvent(...a),
  canonicalJson: (v: unknown) => JSON.stringify(v),
  loadMemexConfig: () => null,
}));

import { ConnectorRegistry } from './connectors/registry.js';
import { DeliveryRouter, resolveTargets, SILENCE_MARKER } from './delivery-router.js';
import type { ConnectorAdapter } from '@graph/types/connector';

function makeConnector(platform: string): ConnectorAdapter & { sent: Array<[string, string]>; failTimes: number } {
  const c = {
    sent: [] as Array<[string, string]>,
    failTimes: 0,
    meta: { platform, required_env: [] },
    check: async () => ({ ok: true }),
    validateConfig: () => ({ ok: true }),
    start: async () => {},
    async send(target: string, text: string) {
      if (c.failTimes > 0) {
        c.failTimes--;
        throw new Error('send failed');
      }
      c.sent.push([target, text]);
    },
  };
  return c;
}

const homes = { telegram: 'telegram:HOME-T', slack: 'HOME-S' };

let registry: ConnectorRegistry;
let telegram: ReturnType<typeof makeConnector>;
let slack: ReturnType<typeof makeConnector>;

beforeEach(() => {
  vi.clearAllMocks();
  registry = new ConnectorRegistry();
  telegram = makeConnector('telegram');
  slack = makeConnector('slack');
  registry.register(telegram);
  registry.register(slack);
});

describe('resolveTargets — five syntaxes', () => {
  it('origin resolves the channel-prefixed origin', () => {
    const { targets } = resolveTargets('origin', registry, 'telegram:123', homes);
    expect(targets).toEqual([{ platform: 'telegram', chat_id: '123' }]);
  });

  it('bare platform resolves its home channel', () => {
    const { targets } = resolveTargets('telegram', registry, undefined, homes);
    expect(targets).toEqual([{ platform: 'telegram', chat_id: 'HOME-T' }]);
  });

  it('platform:chat_id resolves explicitly', () => {
    const { targets } = resolveTargets('slack:C42', registry, undefined, homes);
    expect(targets).toEqual([{ platform: 'slack', chat_id: 'C42' }]);
  });

  it('all resolves every registered platform home', () => {
    const { targets } = resolveTargets('all', registry, undefined, homes);
    expect(targets).toContainEqual({ platform: 'telegram', chat_id: 'HOME-T' });
    expect(targets).toContainEqual({ platform: 'slack', chat_id: 'HOME-S' });
  });

  it('comma combination resolves and de-dups', () => {
    const { targets } = resolveTargets('origin,telegram:123,slack:C1', registry, 'telegram:123', homes);
    expect(targets).toEqual([
      { platform: 'telegram', chat_id: '123' },
      { platform: 'slack', chat_id: 'C1' },
    ]);
  });

  it('missing home channel yields an error, not a throw', () => {
    const { targets, errors } = resolveTargets('discord', registry, undefined, homes);
    expect(targets).toEqual([]);
    expect(errors[0]).toContain('discord');
  });
});

describe('DeliveryRouter', () => {
  it('delivers to resolved targets via connector.send', async () => {
    const router = new DeliveryRouter(registry, null, homes);
    const result = await router.deliver({ deliver: 'origin', text: 'hi', origin: 'telegram:9' });
    expect(result.delivered).toEqual([{ platform: 'telegram', chat_id: '9' }]);
    expect(telegram.sent).toEqual([['9', 'hi']]);
  });

  it('suppresses silence-marked output entirely', async () => {
    const router = new DeliveryRouter(registry, null, homes);
    const result = await router.deliver({ deliver: 'all', text: `${SILENCE_MARKER} nothing to say` });
    expect(result.suppressed).toBe(true);
    expect(telegram.sent).toHaveLength(0);
  });

  it('retries once then records delivery::failed in the graph', async () => {
    telegram.failTimes = 2; // both attempts fail
    const router = new DeliveryRouter(registry, {} as Pool, homes);
    const result = await router.deliver({
      deliver: 'telegram:9', text: 'x', scope_id: 'scope-d',
    });
    expect(result.failed).toEqual([{ platform: 'telegram', chat_id: '9' }]);
    expect(mockWriteInfraEvent).toHaveBeenCalledWith(
      expect.anything(), 'scope-d', 'memory_updated',
      expect.stringContaining('delivery::failed'), 'archived',
    );
  });

  it('single transient failure succeeds on retry without a failure record', async () => {
    telegram.failTimes = 1;
    const router = new DeliveryRouter(registry, {} as Pool, homes);
    const result = await router.deliver({ deliver: 'telegram:9', text: 'x', scope_id: 's' });
    expect(result.delivered).toHaveLength(1);
    expect(mockWriteInfraEvent).not.toHaveBeenCalled();
  });
});
