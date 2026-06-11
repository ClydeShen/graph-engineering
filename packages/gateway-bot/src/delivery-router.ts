/**
 * DeliveryRouter — cross-platform result delivery (Phase 12 deliverable #4).
 *
 * Target syntax (hermes delivery.py parity):
 *   'origin'                 — back to the originating channel:chat
 *   '<platform>'             — the platform's home channel (config.json slot)
 *   '<platform>:<chat_id>'   — explicit chat on a platform
 *   'all'                    — home channel of every registered platform
 *   comma combinations       — e.g. 'origin,slack:C123'
 *
 * Silence marker: replies starting with [SILENT] are not delivered (hermes
 * silent-output suppression).
 *
 * expects_reply (Phase 14 forward contract): approval-flow messages set this
 * so the connector can mark the message as awaiting /approve|/deny. Phase 12
 * passes it through; no approval semantics yet.
 *
 * Failure policy: one retry, then a `delivery::failed` record in the graph —
 * no exponential-backoff queue (YAGNI per 12-PHASE-SPEC §2d).
 */

import type { Pool } from 'pg';
import { canonicalJson, writeInfraEvent, loadMemexConfig } from '@graph/shared';
import type { ConnectorRegistry } from './connectors/registry.js';

export const SILENCE_MARKER = '[SILENT]';

export interface DeliveryRequest {
  /** Target expression (see syntax above). */
  deliver: string;
  text: string;
  /** Originating channel-prefixed chat, e.g. 'telegram:12345' — resolves 'origin'. */
  origin?: string;
  /** Phase 14 slot: message expects an /approve|/deny style reply. */
  expects_reply?: boolean;
  /** Scope to record delivery failures against. */
  scope_id?: string;
}

export interface ResolvedTarget {
  platform: string;
  chat_id: string;
}

/** Resolve a deliver expression into concrete (platform, chat_id) targets. */
export function resolveTargets(
  deliver: string,
  registry: ConnectorRegistry,
  origin?: string,
  homeChannels?: Record<string, string | undefined>,
): { targets: ResolvedTarget[]; errors: string[] } {
  const targets: ResolvedTarget[] = [];
  const errors: string[] = [];
  const homes = homeChannels ?? loadHomeChannels();

  const pushHome = (platform: string): void => {
    const home = homes[platform];
    if (home === undefined) {
      errors.push(`no home_channel configured for ${platform}`);
      return;
    }
    // home may itself be 'platform:chat' or bare chat id
    const chat = home.includes(':') ? home.slice(home.indexOf(':') + 1) : home;
    targets.push({ platform, chat_id: chat });
  };

  for (const part of deliver.split(',').map((p) => p.trim()).filter((p) => p.length > 0)) {
    if (part === 'origin') {
      if (origin === undefined || !origin.includes(':')) {
        errors.push('origin target requested but no origin available');
        continue;
      }
      const idx = origin.indexOf(':');
      targets.push({ platform: origin.slice(0, idx), chat_id: origin.slice(idx + 1) });
      continue;
    }
    if (part === 'all') {
      for (const connector of registry.list()) pushHome(connector.meta.platform);
      continue;
    }
    if (part.includes(':')) {
      const idx = part.indexOf(':');
      targets.push({ platform: part.slice(0, idx), chat_id: part.slice(idx + 1) });
      continue;
    }
    pushHome(part);
  }

  // de-dup
  const seen = new Set<string>();
  const unique = targets.filter((t) => {
    const key = `${t.platform}:${t.chat_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { targets: unique, errors };
}

function loadHomeChannels(): Record<string, string | undefined> {
  const channels = loadMemexConfig()?.channels ?? {};
  const homes: Record<string, string | undefined> = {};
  for (const [platform, entry] of Object.entries(channels)) {
    homes[platform] = (entry as { home_channel?: string }).home_channel;
  }
  return homes;
}

export class DeliveryRouter {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly pool: Pool | null = null,
    private readonly homeChannels?: Record<string, string | undefined>,
  ) {}

  /**
   * Deliver to all resolved targets. Per-target: one retry, then a
   * delivery::failed graph record (best-effort). Returns per-target outcomes.
   */
  async deliver(req: DeliveryRequest): Promise<{ delivered: ResolvedTarget[]; failed: ResolvedTarget[]; suppressed: boolean }> {
    if (req.text.startsWith(SILENCE_MARKER)) {
      return { delivered: [], failed: [], suppressed: true };
    }

    const { targets } = resolveTargets(req.deliver, this.registry, req.origin, this.homeChannels);
    const delivered: ResolvedTarget[] = [];
    const failed: ResolvedTarget[] = [];

    for (const target of targets) {
      const connector = this.registry.get(target.platform);
      if (connector === undefined) {
        failed.push(target);
        await this.recordFailure(req, target, 'unknown platform');
        continue;
      }
      const ok = await this.trySend(connector, target.chat_id, req.text);
      if (ok) {
        delivered.push(target);
      } else {
        failed.push(target);
        await this.recordFailure(req, target, 'send failed after retry');
      }
    }
    return { delivered, failed, suppressed: false };
  }

  private async trySend(
    connector: { send(target: string, text: string): Promise<void> },
    chatId: string,
    text: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await connector.send(chatId, text);
        return true;
      } catch {
        /* retry once */
      }
    }
    return false;
  }

  private async recordFailure(req: DeliveryRequest, target: ResolvedTarget, reason: string): Promise<void> {
    if (this.pool === null || req.scope_id === undefined) return;
    try {
      await writeInfraEvent(
        this.pool,
        req.scope_id,
        'memory_updated',
        canonicalJson({
          kind: 'delivery::failed',
          platform: target.platform,
          chat_id: target.chat_id,
          reason,
          at: new Date().toISOString(),
        }),
        'archived',
      );
    } catch {
      /* failure recording is best-effort */
    }
  }
}
