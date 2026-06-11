/**
 * ConnectorRegistry — declarative connector registration (Phase 12, hermes
 * PlatformEntry pattern over the frozen ConnectorAdapter contract).
 *
 * The registry is a runtime object; connector CONFIG CHANGES are graph data:
 * registerConfigChange() appends a `connector::config_updated`-tagged
 * memory_updated event so configuration history is queryable and Trail
 * Discovery can analyze it (12-PHASE-SPEC §2a differentiator vs hermes).
 *
 * Dashboard's "connected channels" panel consumes statusReport() directly —
 * no reflection probing.
 */

import type { Pool } from 'pg';
import { canonicalJson, writeInfraEvent } from '@graph/shared';
import type { ConnectorAdapter, ConnectorCheckResult } from '@graph/types/connector';

export interface ConnectorStatus {
  platform: string;
  required_env: string[];
  configured: boolean;
  check: ConnectorCheckResult;
}

export class ConnectorRegistry {
  private connectors = new Map<string, ConnectorAdapter>();

  register(connector: ConnectorAdapter): void {
    this.connectors.set(connector.meta.platform, connector);
  }

  get(platform: string): ConnectorAdapter | undefined {
    return this.connectors.get(platform);
  }

  list(): ConnectorAdapter[] {
    return [...this.connectors.values()];
  }

  /**
   * Probe every registered connector: env completeness + live check.
   * Connectors that fail are reported, not thrown — graceful skip (hermes
   * check_fn semantics): one broken channel never blocks the others.
   */
  async statusReport(): Promise<ConnectorStatus[]> {
    const report: ConnectorStatus[] = [];
    for (const connector of this.connectors.values()) {
      const configured = connector.meta.required_env.every(
        (env) => (process.env[env] ?? '') !== '',
      );
      let check: ConnectorCheckResult;
      if (!configured) {
        check = { ok: false, detail: 'missing env: ' + connector.meta.required_env.filter((e) => !process.env[e]).join(', ') };
      } else {
        try {
          check = await connector.check();
        } catch (err) {
          check = { ok: false, detail: err instanceof Error ? err.message : String(err) };
        }
      }
      report.push({
        platform: connector.meta.platform,
        required_env: connector.meta.required_env,
        configured,
        check,
      });
    }
    return report;
  }

  /**
   * Start every connector whose check passes. Returns the started platforms.
   * Failures are skipped (logged by the caller), never fatal.
   */
  async startAll(
    onMessage: Parameters<ConnectorAdapter['start']>[0],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const started: string[] = [];
    for (const status of await this.statusReport()) {
      if (!status.check.ok) continue;
      const connector = this.connectors.get(status.platform)!;
      void connector.start(onMessage, signal).catch(() => {
        /* inbound loop crash must not take down siblings */
      });
      started.push(status.platform);
    }
    return started;
  }
}

/** Well-known scope intent that anchors connector config history in the graph. */
export const CONNECTOR_CONFIG_SCOPE_INTENT = 'connector:registry';

/**
 * Record a connector configuration change in the graph
 * (`connector::config_updated` Association). Secrets must be redacted by the
 * caller — pass key NAMES, never values.
 */
export async function recordConfigChange(
  pool: Pool,
  scopeId: string,
  platform: string,
  changedKeys: string[],
): Promise<void> {
  await writeInfraEvent(
    pool,
    scopeId,
    'memory_updated',
    canonicalJson({
      kind: 'connector::config_updated',
      platform,
      changed_keys: changedKeys,
      at: new Date().toISOString(),
    }),
    'archived',
  );
}
