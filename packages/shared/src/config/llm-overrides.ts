/**
 * LLM settings overrides (CONSOLE-REDESIGN Appendix A) — the console's one known
 * write exception. Persisted in a STANDALONE JSON file
 * (<profile>/llm-overrides.json): never .env (can't persist UI input), never the
 * graph (keeps API keys out of the immutable trail — audit/snapshot safety),
 * never iii-config.yaml (carries no LLM fields). Shape: a single `chat` slot +
 * an independent `embedding` axis (Memex is an async graph runtime with no
 * latency-tiered fast/slow model need; chat and embedding are distinct
 * interfaces per ADR 22).
 *
 * This module is the FOUNDATION: read/write/merge with unit-tested merge. Gateway
 * merges overrides into MemexConfig at provider construction (below). The
 * credential-writing surfaces — a token-guarded POST endpoint + the Settings
 * write form — are a security-sensitive follow-up (Appendix A: "not yet
 * implemented as a UI write surface"; ROADMAP 21 / §9 B-list). Until then the
 * write path is the CLI / this file directly, exactly as Appendix A states.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { MemexConfig } from './loader.js';
import { profileDir } from './loader.js';

const LlmSlotSchema = z.object({
  /** Provider profile name or api kind (e.g. 'openai', 'anthropic', 'ollama'). */
  type: z.string().optional(),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
});

export const LlmOverridesSchema = z.object({
  chat: LlmSlotSchema.optional(),
  embedding: LlmSlotSchema.optional(),
});
export type LlmOverrides = z.infer<typeof LlmOverridesSchema>;

/** Override file path for the active profile. */
export function llmOverridesPath(): string {
  return join(profileDir(), 'llm-overrides.json');
}

/** Read + validate the overrides file. Returns null when absent or malformed. */
export function readLlmOverrides(path: string = llmOverridesPath()): LlmOverrides | null {
  if (!existsSync(path)) return null;
  try {
    return LlmOverridesSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Write the overrides file (creates the profile dir if needed). */
export function writeLlmOverrides(overrides: LlmOverrides, path: string = llmOverridesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(overrides, null, 2), 'utf8');
}

/**
 * Merge overrides into a MemexConfig (pure). The `chat` slot replaces the
 * provider registry with a single override entry (Appendix A: single slot, not
 * hermes-style primary/secondary tiers). The `embedding` slot replaces the
 * embedding section. When there are no overrides this is the identity — so
 * provider construction is unchanged for every install without the file
 * (zero-regression).
 */
export function mergeLlmOverrides(
  config: MemexConfig | null,
  overrides: LlmOverrides | null,
): MemexConfig | null {
  if (!overrides || (!overrides.chat && !overrides.embedding)) return config;
  const next: MemexConfig = { ...(config ?? {}) };
  if (overrides.chat) {
    next.providers = [
      {
        name: overrides.chat.type ?? 'override',
        type: overrides.chat.type ?? 'openai',
        model: overrides.chat.model ?? '',
        baseUrl: overrides.chat.baseUrl,
        apiKey: overrides.chat.apiKey,
        priority: 1,
      },
    ];
  }
  if (overrides.embedding) {
    next.embedding = {
      provider: overrides.embedding.type,
      baseUrl: overrides.embedding.baseUrl,
      model: overrides.embedding.model,
      apiKey: overrides.embedding.apiKey,
    };
  }
  return next;
}
