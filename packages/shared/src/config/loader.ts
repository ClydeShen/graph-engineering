/**
 * ~/.memex/config.json loader with Zod validation and ${ENV_VAR} interpolation.
 *
 * Returns null when:
 *   - The file does not exist
 *   - The file contains malformed JSON
 *   - The parsed value fails Zod validation
 *
 * System boots from env vars alone — no config file required.
 *
 * Config layering (locked): iii-config.yaml → MemexCore (Worker LLMProvider,
 * iii-engine params); ~/.memex/config.json → system-wide (Shell + Gateway +
 * channels + provider registry). Resolved env values are never written back.
 *
 * Resurrected (Phase 11) from the dead-code sprint removal — now consumed by
 * Gateway boot and the Onboarding TUI. Schema extended with Phase 12 forward-
 * contract slots (home_channel, webhook.hmac_secret) so Phase 12 fills values
 * without changing the structure (11-PHASE-SPEC §6.3).
 *
 * @see ARCH-04 — Config loader design
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/** Default path to the Memex config file. */
export const DEFAULT_CONFIG_PATH = join(homedir(), '.memex', 'config.json');

const ProviderEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string(),
  priority: z.number().int().positive(),
});

/** Per-channel config: token plus the Phase 12 home_channel delivery slot. */
const ChannelEntrySchema = z
  .object({
    token: z.string().optional(),
    /** Phase 12 DeliveryRouter: default delivery target for this platform. */
    home_channel: z.string().optional(),
  })
  .passthrough();

/** Zod schema for ~/.memex/config.json. All top-level fields are optional — Gateway falls back to env vars. */
export const MemexConfigSchema = z.object({
  gateway: z
    .object({
      port: z.number().int().positive(),
      /** Realtime API toggle (ADR-53). Default true at the consumer. */
      websocket: z.boolean().optional(),
      /** Shared token for WS/SSE client auth. ${ENV_VAR} interpolation applies. */
      token: z.string().optional(),
    })
    .optional(),
  providers: z.array(ProviderEntrySchema).optional(),
  channels: z.record(z.string(), ChannelEntrySchema).optional(),
  /** Phase 12 slot: inbound webhook HMAC secret (channel refuses to start without it). */
  webhook: z.object({ hmac_secret: z.string().optional() }).optional(),
  /** Shell connection addresses (MemexTerminal / Dashboard → Gateway). */
  shell: z.object({ gateway_url: z.string().optional() }).optional(),
});

/** Inferred type for the parsed Memex config. */
export type MemexConfig = z.infer<typeof MemexConfigSchema>;

/**
 * Replaces all ${VAR_NAME} placeholders in the raw JSON string with
 * process.env[VAR_NAME] values. Unresolved variables are replaced with ''.
 * Runs before JSON.parse so the result is always valid JSON with concrete values.
 */
function resolveEnvVars(raw: string): string {
  return raw.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
    return process.env[varName] ?? '';
  });
}

/**
 * Reads, parses, and validates ~/.memex/config.json (or a custom path).
 *
 * Returns null on any failure — missing file, bad JSON, or Zod validation error.
 * The system MUST be able to boot with this returning null (env vars fallback).
 *
 * @param configPath - Path to the config file. Defaults to ~/.memex/config.json.
 */
export function loadMemexConfig(configPath: string = DEFAULT_CONFIG_PATH): MemexConfig | null {
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const raw = readFileSync(configPath, 'utf8');
    const resolved = resolveEnvVars(raw);
    const parsed: unknown = JSON.parse(resolved);
    return MemexConfigSchema.parse(parsed);
  } catch {
    return null;
  }
}
