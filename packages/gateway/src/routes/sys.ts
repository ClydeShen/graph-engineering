/**
 * GET /v1/sys/config — redacted configuration projection for the Settings page.
 *
 * The Dashboard is a read-only projection (locked MemexShell principle), so this
 * surfaces the ACTIVE provider/embedding/gateway/channel configuration without
 * ever returning secrets: gateway.token and any resolved apiKey are replaced
 * with presence booleans. `${ENV_VAR}` references are shown verbatim (they name
 * an env var, they are not the secret). Editing config stays a CLI concern
 * (memex onboard) until the CONSOLE-REDESIGN writable LLM-settings exception
 * lands (docs/CONSOLE-REDESIGN.md Appendix A).
 *
 * @see packages/shared/src/llm/provider-profiles.ts — display + embedding caps
 * @see packages/shared/src/llm/from-config.ts — embedding endpoint resolution
 */

import { Hono } from 'hono';
import {
  loadMemexConfig,
  resolveConfigPath,
  activeProfile,
  resolveProfile,
  resolveEmbeddingEndpoint,
} from '@graph/shared';

/** True for a real secret value; false for absent or a ${ENV_VAR} reference. */
function hasResolvedSecret(v: string | undefined): boolean {
  return typeof v === 'string' && v.length > 0 && !/^\$\{[^}]+\}$/.test(v);
}

export function buildSysConfigRoute(): Hono {
  const app = new Hono();

  app.get('/sys/config', (c) => {
    const config = loadMemexConfig();

    const providers = (config?.providers ?? []).map((p) => {
      const profile = resolveProfile(p);
      return {
        name: p.name,
        display_name: profile.displayName,
        model: p.model,
        priority: p.priority,
        base_url: p.baseUrl ?? profile.baseUrl ?? null,
        api: profile.api,
        local: profile.local === true,
        supports_embedding: profile.supportsEmbedding,
        // ${ENV_VAR} ref vs resolved key vs none — never the value itself.
        api_key: p.apiKey === undefined ? 'none' : /^\$\{[^}]+\}$/.test(p.apiKey) ? p.apiKey : 'set',
      };
    });

    const embedding = resolveEmbeddingEndpoint(config);

    const channels = Object.entries(config?.channels ?? {}).map(([platform, entry]) => ({
      platform,
      configured: hasResolvedSecret(entry?.token) || /^\$\{[^}]+\}$/.test(entry?.token ?? ''),
      home_channel: entry?.home_channel ?? null,
    }));

    return c.json({
      config_path: resolveConfigPath(),
      profile: activeProfile(),
      config_present: config !== null,
      gateway: {
        port: config?.gateway?.port ?? null,
        websocket: config?.gateway?.websocket ?? true,
        token_set: hasResolvedSecret(config?.gateway?.token),
      },
      providers,
      embedding:
        embedding === null
          ? { configured: false, source: null, base_url: null, model: null }
          : {
              configured: true,
              source: embedding.source,
              base_url: embedding.baseUrl,
              model: embedding.model,
            },
      channels,
    });
  });

  return app;
}
