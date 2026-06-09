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

/** Zod schema for ~/.memex/config.json. All top-level fields are optional — Gateway falls back to env vars. */
export const MemexConfigSchema = z.object({
  gateway: z.object({ port: z.number().int().positive() }).optional(),
  providers: z.array(ProviderEntrySchema).optional(),
  channels: z.record(z.string(), z.unknown()).optional(),
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
