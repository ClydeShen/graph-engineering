/**
 * McpCatalogRegistry — repo-internal MCP server catalog (Phase 17 Block 1,
 * ADR-50). Shape follows ConnectorRegistry (list / get / validate / status).
 *
 * Catalog entries are `optional-mcps/<name>/manifest.yaml`, PR-gated — the
 * same "pre-reviewed but reviewable" trust model as skills-guard. A manifest
 * maps losslessly onto a Claude Code `mcpServers` JSON entry or a Hermes
 * `mcp_servers` YAML entry (superset).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { McpServerEntrySchema, type McpServerEntry } from '@graph/shared';

export const McpManifestSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'unsafe manifest name'),
  description: z.string(),
  transport: z
    .object({
      command: z.string().optional(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      auth: z.literal('oauth').optional(),
    })
    .refine((t) => (t.command !== undefined) !== (t.url !== undefined), {
      message: 'exactly one of transport.command or transport.url is required',
    }),
  /** Env vars prompted at install when unset. */
  requires_env: z.array(z.string()).optional(),
  tools: z.object({ default_enabled: z.array(z.string()).optional() }).optional(),
});

export type McpManifest = z.infer<typeof McpManifestSchema>;

export interface CatalogStatus {
  name: string;
  description: string;
  /** requires_env vars currently unset in the environment. */
  missing_env: string[];
  installed: boolean;
}

/** Map a manifest to the config entry written by `memex mcp install`. */
export function manifestToConfigEntry(manifest: McpManifest): McpServerEntry {
  const t = manifest.transport;
  const entry: McpServerEntry = {
    ...(t.command !== undefined
      ? { command: t.command, ...(t.args ? { args: t.args } : {}), ...(t.env ? { env: t.env } : {}) }
      : { url: t.url!, ...(t.headers ? { headers: t.headers } : {}) }),
    ...(t.auth ? { auth: t.auth } : {}),
    ...(manifest.tools?.default_enabled ? { tools: { include: manifest.tools.default_enabled } } : {}),
    enabled: true,
  };
  return McpServerEntrySchema.parse(entry); // both schemas enforce their invariants
}

export class McpCatalogRegistry {
  constructor(private readonly catalogRoot: string) {}

  /** All parseable manifests; malformed ones are skipped with a warning entry. */
  list(): McpManifest[] {
    if (!existsSync(this.catalogRoot)) return [];
    const manifests: McpManifest[] = [];
    for (const dir of readdirSync(this.catalogRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const m = this.get(dir.name);
      if (m) manifests.push(m);
    }
    return manifests;
  }

  /** Parse + validate one manifest; null when missing or invalid. */
  get(name: string): McpManifest | null {
    const file = join(this.catalogRoot, name, 'manifest.yaml');
    if (!existsSync(file)) return null;
    try {
      const parsed = McpManifestSchema.parse(parseYaml(readFileSync(file, 'utf8')));
      // Directory name is the identity (same rule as SKILL.md name field).
      return parsed.name === name ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Raw manifest text (for guard scanning before install). */
  rawContent(name: string): string | null {
    const file = join(this.catalogRoot, name, 'manifest.yaml');
    return existsSync(file) ? readFileSync(file, 'utf8') : null;
  }

  /** Probe requires_env + installed state for the catalog listing. */
  statusReport(installedNames: Set<string>, env: NodeJS.ProcessEnv = process.env): CatalogStatus[] {
    return this.list().map((m) => ({
      name: m.name,
      description: m.description,
      missing_env: (m.requires_env ?? []).filter((v) => !env[v]),
      installed: installedNames.has(m.name),
    }));
  }
}
