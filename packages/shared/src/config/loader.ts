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

/**
 * Single gateway port default (ADR 56 D-5). Consumed by gateway boot, terminal,
 * doctor, onboarding, and dev.mjs — 4000 avoids the Next.js console default
 * (3000). Override order: config gateway.port > PORT env > this constant.
 */
export const DEFAULT_GATEWAY_PORT = 4000;

/** Root of all Memex state on this machine. */
export function memexHome(): string {
  return join(homedir(), '.memex');
}

/**
 * Profile resolution (Phase 15 G5). `MEMEX_PROFILE=<name>` selects
 * `~/.memex/profiles/<name>/config.json`; unset/empty selects the top-level
 * `~/.memex/config.json` (zero-migration backward compatibility). Profile
 * names with path separators or dots are rejected (traversal guard) and fall
 * back to the default profile.
 */
export function activeProfile(): string | null {
  const name = process.env['MEMEX_PROFILE'];
  if (!name) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return null;
  return name;
}

/** Directory holding the active profile's config (and profile-scoped state). */
export function profileDir(): string {
  const name = activeProfile();
  return name ? join(memexHome(), 'profiles', name) : memexHome();
}

/** Config path for the active profile — call-time resolution so env changes apply. */
export function resolveConfigPath(): string {
  return join(profileDir(), 'config.json');
}

const ProviderEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  model: z.string(),
  priority: z.number().int().positive(),
});

/** Inferred type for one provider registry entry (loader-local — the public
 *  provider type lives in ./llm). */
type ConfigProviderEntry = z.infer<typeof ProviderEntrySchema>;

/** Per-channel config: token plus the Phase 12 home_channel delivery slot. */
const ChannelEntrySchema = z
  .object({
    token: z.string().optional(),
    /** Phase 12 DeliveryRouter: default delivery target for this platform. */
    home_channel: z.string().optional(),
    /**
     * Per-channel LLM (CONSOLE-REDESIGN §11.2 — "agent identity"): references a
     * providers[].name. Unset → the channel uses the global default provider.
     * This is the config SEAM; gateway-bot provider routing consumes it (full
     * wiring is ROADMAP 22-workspace-project).
     */
    llm: z.string().optional(),
  })
  .passthrough();

/**
 * One MCP server entry (Phase 17, ADR-50). Field names align with Claude Code
 * `mcpServers` JSON and Hermes `mcp_servers` YAML so users of either can port
 * entries verbatim: stdio uses command/args/env, HTTP uses url/headers.
 *
 * ADR-51 D-1: these are OPERATIONAL fields (connection bootstrap). The policy
 * fields (`tools`, `enabled`) are desired-state INPUT kept here only for
 * Claude Code / Hermes compatibility — the effective tool surface after
 * connecting is observed into the graph (`memex::capability::surface_changed`),
 * which is the semantic authority.
 */
export const McpServerEntrySchema = z
  .object({
    /** stdio transport: executable to spawn. */
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** http/streamable transport: server URL. */
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    /** 'oauth' triggers the PKCE flow (memex mcp login) and authProvider wiring. */
    auth: z.literal('oauth').optional(),
    /** Desired-state tool filter (Hermes tools.include semantics). */
    tools: z
      .object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
      })
      .optional(),
    enabled: z.boolean().optional(),
  })
  .refine((e) => (e.command !== undefined) !== (e.url !== undefined), {
    message: 'exactly one of command (stdio) or url (http) is required',
  });

/** Inferred type for one MCP server entry. */
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

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
  /**
   * Optional embedding endpoint (ADR 55/56). Embedding is NOT required —
   * absent/unreachable means the semantic index runs in degraded mode
   * (late-projection backfill + lexical retrieval), never blocking conversation.
   * `provider` references a ProviderProfile name; explicit fields override it.
   */
  embedding: z
    .object({
      provider: z.string().optional(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .optional(),
  channels: z.record(z.string(), ChannelEntrySchema).optional(),
  /** Phase 12 slot: inbound webhook HMAC secret (channel refuses to start without it). */
  webhook: z.object({ hmac_secret: z.string().optional() }).optional(),
  /** Shell connection addresses (MemexTerminal / Dashboard → Gateway). */
  shell: z.object({ gateway_url: z.string().optional() }).optional(),
  /** Phase 15: per-profile database isolation — full connection string. */
  database: z.object({ url: z.string().optional() }).optional(),
  /** Phase 17: MCP server registry (Claude Code / Hermes compatible shape). */
  mcp_servers: z.record(z.string(), McpServerEntrySchema).optional(),
});

/** Inferred type for the parsed Memex config. */
export type MemexConfig = z.infer<typeof MemexConfigSchema>;

/**
 * Resolve which provider a channel should use (CONSOLE-REDESIGN §11.2 —
 * per-channel LLM / "agent identity"). Returns the providers[] entry whose
 * `name` matches the channel's `llm` field, or undefined when the channel has
 * no override (the caller then falls back to the global default — typically the
 * priority-ordered providers[0]). Pure; this is the resolution SEAM that
 * gateway-bot provider routing consumes (full wiring is ROADMAP
 * 22-workspace-project).
 */
export function resolveChannelProvider(
  config: MemexConfig | null,
  platform: string,
): ConfigProviderEntry | undefined {
  const llmName = config?.channels?.[platform]?.llm;
  if (llmName === undefined || llmName === '') return undefined;
  return config?.providers?.find((p) => p.name === llmName);
}

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
 * @param configPath - Path to the config file. Defaults to the active profile's
 *   config (resolveConfigPath() — honours MEMEX_PROFILE at call time).
 */
export function loadMemexConfig(configPath: string = resolveConfigPath()): MemexConfig | null {
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
