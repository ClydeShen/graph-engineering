/**
 * Config-driven provider construction (ADR 56) — the single place where
 * ~/.memex/config.json providers[] become live LLMProvider/EmbeddingProvider
 * instances. Gateway, workers, and the conversation core all build through
 * here; scattered LLM_* env vars are the legacy fallback, not the main path.
 *
 * Chat: providers[] sorted by priority → FallbackProvider (activates the
 * ADR 22 failover chain that was previously dead code).
 *
 * Embedding: NULLABLE by design (ADR 55). Selection order:
 *   1. explicit config.embedding entry
 *   2. highest-priority providers[] entry whose profile supportsEmbedding
 *   3. legacy env (EMBEDDING_MODEL / LLM_BASE_URL) when no config file
 *   4. null — semantic index runs degraded; conversation is never blocked
 */

import type { MemexConfig } from '../config/loader.js';
import { resolveChannelProvider } from '../config/loader.js';
import type { LLMProvider, EmbeddingProvider } from './provider.interface.js';
import { createLLMProvider } from './factory.js';
import { OpenAICompatibleProvider } from './openai-compatible.provider.js';
import { FallbackProvider, type ProviderEntry } from './fallback.provider.js';
import { resolveProfile, type ProviderProfile } from './provider-profiles.js';

type ConfigProviderEntry = NonNullable<MemexConfig['providers']>[number];

/** Build one concrete provider from a config entry + its resolved profile. */
function buildOne(entry: ConfigProviderEntry, profile: ProviderProfile): LLMProvider {
  return createLLMProvider({
    api: profile.api,
    model: entry.model,
    baseUrl: entry.baseUrl ?? profile.baseUrl,
    apiKey: entry.apiKey ?? (profile.envVar ? process.env[profile.envVar] ?? '' : ''),
  });
}

/**
 * Chat provider from config, with env-only fallback (system must boot with
 * no config file — loader contract). Multiple entries become a fallback chain.
 */
export function buildChatProvider(
  config: MemexConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider {
  const entries = config?.providers ?? [];
  if (entries.length === 1) {
    return buildOne(entries[0]!, resolveProfile(entries[0]!));
  }
  if (entries.length > 1) {
    const chain: ProviderEntry[] = entries.map((e) => ({
      name: e.name,
      priority: e.priority,
      provider: buildOne(e, resolveProfile(e)),
    }));
    return new FallbackProvider(chain);
  }
  // Legacy env-only boot (pre-ADR-56 path, kept for compatibility)
  return createLLMProvider({
    api: env['LLM_API'] === 'anthropic-messages' ? 'anthropic-messages' : 'openai-completions',
    model: env['LLM_MODEL'] ?? 'llama3',
    baseUrl: env['LLM_BASE_URL'],
    apiKey: env['LLM_API_KEY'] ?? '',
    maxTokens: env['LLM_MAX_TOKENS'] ? Number(env['LLM_MAX_TOKENS']) : undefined,
  });
}

/**
 * Per-channel chat provider (CONSOLE-REDESIGN §11.2 — "agent identity"). When a
 * channel declares `channels[platform].llm` referencing a providers[] entry,
 * that channel's conversations run on its own model — a distinct "agent" per
 * channel. Returns null when the channel has no override; the caller then uses
 * the global default provider (ADR-54 server-side single responder is preserved
 * — the responder still runs server-side, it just dials the channel's model).
 */
export function buildChannelChatProvider(
  config: MemexConfig | null,
  platform: string,
): LLMProvider | null {
  const entry = resolveChannelProvider(config, platform);
  if (entry === undefined) return null;
  return buildOne(entry, resolveProfile(entry));
}

/** Resolved embedding endpoint — also consumed by doctor (probe derivation). */
export interface EmbeddingEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Where the resolution came from (diagnostics). */
  source: 'embedding-section' | 'derived-from-chat' | 'legacy-env';
}

/**
 * Resolve the embedding endpoint from config/env — null when nothing
 * embedding-capable is configured (ADR 55: degraded semantic index).
 * Single resolution path shared by runtime construction and doctor probes.
 */
export function resolveEmbeddingEndpoint(
  config: MemexConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingEndpoint | null {
  // 1. Explicit embedding section wins
  const emb = config?.embedding;
  if (emb && (emb.baseUrl !== undefined || emb.provider !== undefined)) {
    const profile = emb.provider ? resolveProfile({ name: emb.provider }) : undefined;
    const baseUrl = emb.baseUrl ?? profile?.baseUrl;
    const model = emb.model ?? profile?.defaultEmbeddingModel;
    if (baseUrl !== undefined && model !== undefined) {
      return {
        baseUrl,
        model,
        apiKey: emb.apiKey ?? (profile?.envVar ? env[profile.envVar] ?? '' : ''),
        source: 'embedding-section',
      };
    }
  }

  // 2. Derive from the chat chain: first entry whose profile can embed
  const entries = [...(config?.providers ?? [])].sort((a, b) => a.priority - b.priority);
  for (const entry of entries) {
    const profile = resolveProfile(entry);
    if (!profile.supportsEmbedding) continue;
    const baseUrl = entry.baseUrl ?? profile.baseUrl;
    const model = emb?.model ?? env['EMBEDDING_MODEL'] ?? profile.defaultEmbeddingModel;
    // Chat model is never a valid embedding default — skip when no real model known.
    if (baseUrl === undefined || model === undefined) continue;
    return {
      baseUrl,
      model,
      apiKey: entry.apiKey ?? (profile.envVar ? env[profile.envVar] ?? '' : ''),
      source: 'derived-from-chat',
    };
  }

  // 3. Legacy env-only boot: only when explicitly pointed at an endpoint
  if (config === null && env['LLM_BASE_URL'] !== undefined) {
    return {
      baseUrl: env['LLM_BASE_URL'],
      model: env['EMBEDDING_MODEL'] ?? env['LLM_MODEL'] ?? 'llama3',
      apiKey: env['LLM_API_KEY'] ?? '',
      source: 'legacy-env',
    };
  }

  // 4. Nothing embedding-capable — degraded mode (ADR 55)
  return null;
}

/**
 * Embedding provider from config — null when nothing embedding-capable is
 * configured. Callers MUST handle null (ADR 55: degraded semantic index).
 */
export function buildEmbeddingProvider(
  config: MemexConfig | null,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider | null {
  const endpoint = resolveEmbeddingEndpoint(config, env);
  if (endpoint === null) return null;
  return new OpenAICompatibleProvider({
    api: 'openai-completions',
    model: endpoint.model,
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
  });
}
