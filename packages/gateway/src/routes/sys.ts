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
  readLlmOverrides,
  writeLlmOverrides,
  llmOverridesPath,
  LlmOverridesSchema,
  type LlmOverrides,
} from '@graph/shared';

/** True for a real secret value; false for absent or a ${ENV_VAR} reference. */
function hasResolvedSecret(v: string | undefined): boolean {
  return typeof v === 'string' && v.length > 0 && !/^\$\{[^}]+\}$/.test(v);
}

/** Redact one LLM override slot for the read projection (never echo a key). */
function redactSlot(slot: LlmOverrides['chat']): {
  type: string | null;
  model: string | null;
  base_url: string | null;
  api_key_set: boolean;
} | null {
  if (!slot) return null;
  return {
    type: slot.type ?? null,
    model: slot.model ?? null,
    base_url: slot.baseUrl ?? null,
    api_key_set: typeof slot.apiKey === 'string' && slot.apiKey.length > 0,
  };
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
      // Per-channel LLM "agent identity" (CONSOLE-REDESIGN §11.2).
      llm: entry?.llm ?? null,
    }));

    // Appendix A writable LLM settings — surface the standalone overrides file
    // (redacted) so the Settings page can show an active override distinctly
    // from the base config. Effect is on next restart (Appendix A: no hot-reload).
    const overrides = readLlmOverrides();

    return c.json({
      config_path: resolveConfigPath(),
      profile: activeProfile(),
      config_present: config !== null,
      llm_overrides: {
        path: llmOverridesPath(),
        present: overrides !== null,
        chat: redactSlot(overrides?.chat),
        embedding: redactSlot(overrides?.embedding),
      },
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

  // ── Appendix A writable LLM settings (CONSOLE-REDESIGN §6.5) ───────────────
  // The console's ONE known write exception. Security posture (the reason this
  // is the last remaining Phase-21 item): the route is mounted behind the same
  // token gate as the realtime surfaces (index.ts app.use('/v1/sys/llm-overrides'))
  // — unauthorized requests never reach this handler. Defense-in-depth here:
  // fail CLOSED on a malformed body (Zod 400) so a half-formed credential can
  // never be persisted, and never echo a stored key back.
  app.post('/sys/llm-overrides', async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw === null) return c.json({ error: 'invalid JSON body' }, 400);
    const parsed = LlmOverridesSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid llm overrides', issues: parsed.error.issues }, 400);
    }
    // Reject an empty write — clearing is the explicit DELETE below, not POST {}.
    if (!parsed.data.chat && !parsed.data.embedding) {
      return c.json({ error: 'at least one of chat / embedding is required' }, 400);
    }
    try {
      writeLlmOverrides(parsed.data);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'write failed' }, 500);
    }
    // Honest effect semantics (Appendix A): persisted now; the gateway and
    // workers read providers at construction, so the new settings take effect on
    // the next restart. No hot-reload infra (Appendix A: soft-restart out of scope).
    return c.json({ ok: true, applied: 'on-restart', path: llmOverridesPath() });
  });

  app.delete('/sys/llm-overrides', (c) => {
    try {
      writeLlmOverrides({});
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'write failed' }, 500);
    }
    return c.json({ ok: true, applied: 'on-restart' });
  });

  return app;
}
