/**
 * memex mcp — MCP server catalog management (Phase 17 Block 3, ADR-50).
 *
 *   catalog            list optional-mcps/ manifests + status
 *   install <name>     manifest → guard scan → env prompts → config + graph
 *   configure <name>   re-prompt env vars + tool include/exclude
 *   login <name>       OAuth PKCE flow (local callback, token cache on disk)
 *   list               configured servers + connectivity
 *   uninstall <name>   remove config entry + token cache, record to graph
 *
 * Config writes operate on the RAW file (no ${ENV_VAR} resolution) so secrets
 * referenced by name are never baked to disk resolved (ADR-50; loader.ts
 * resolves only at read time).
 *
 * Graph writes (ADR-51): install/uninstall/configure append capability events
 * to the `capability:registry` scope — created here (CLI = operator right,
 * scope creation stays out of workers). DB unreachable → warn, don't block:
 * config remains usable; observation resumes when the DB is back.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAPABILITY_SCOPE_INTENT,
  findCapabilityScope,
  implementationEntityId,
  recordCapabilityEvent,
  resolveConfigPath,
  type McpServerEntry,
} from '@graph/shared';
import { McpCatalogRegistry, manifestToConfigEntry, type McpManifest } from './mcp/catalog-registry.js';
import { writeJsonAtomic } from './connect/util.js';

/** Repo-internal catalog root; MEMEX_CATALOG_DIR overrides for non-repo installs. */
export function catalogRoot(): string {
  if (process.env['MEMEX_CATALOG_DIR']) return process.env['MEMEX_CATALOG_DIR'];
  // packages/cli/src/mcp.ts → repo root /optional-mcps
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'optional-mcps');
}

// ── raw config editing (no env resolution) ─────────────────────────────────

interface RawConfig {
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function readRawConfig(path: string = resolveConfigPath()): RawConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  } catch {
    throw new Error(`malformed config at ${path} — fix or remove it first`);
  }
}

export function upsertServerEntry(cfg: RawConfig, name: string, entry: McpServerEntry): RawConfig {
  return { ...cfg, mcp_servers: { ...(cfg.mcp_servers ?? {}), [name]: entry } };
}

export function removeServerEntry(cfg: RawConfig, name: string): RawConfig {
  const servers = { ...(cfg.mcp_servers ?? {}) };
  delete servers[name];
  return { ...cfg, mcp_servers: servers };
}

export function writeRawConfig(cfg: RawConfig, path: string = resolveConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, cfg);
}

// ── capability graph (best-effort from the CLI) ────────────────────────────

import { withPool } from './db.js';

/** Find-or-create the capability registry scope (nestScope = control-plane right). */
async function ensureCapabilityScope(pool: import('pg').Pool): Promise<string> {
  const existing = await findCapabilityScope(pool);
  if (existing) return existing;
  const { nestScope } = await import('@graph/control-plane/nesting');
  const { scopeId } = await nestScope(pool, CAPABILITY_SCOPE_INTENT);
  return scopeId;
}

async function recordToGraph(
  kind: 'installed' | 'uninstalled' | 'configured',
  name: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    const done = await withPool(async (pool) => {
      const scopeId = await ensureCapabilityScope(pool);
      await recordCapabilityEvent(pool, scopeId, kind, {
        capability: name,
        form: 'mcp',
        implementation_entity_id: implementationEntityId(name),
        ...detail,
      });
      return true;
    });
    if (!done) console.log('note: no DATABASE_URL — capability graph record skipped');
  } catch (err) {
    console.log(
      `note: capability graph record failed (${err instanceof Error ? err.message : String(err)}) — config write succeeded`,
    );
  }
}

// ── OAuth login (Block 2) ───────────────────────────────────────────────────

/** Open the system browser (WSL-aware via wsl.ts); always print the URL as the fallback UX. */
function openBrowser(url: string): void {
  console.log(`authorize in your browser:\n  ${url}`);
  void import('./wsl.js').then(({ openUrl }) => openUrl(url));
}

export async function runLogin(name: string): Promise<void> {
  const { loadMemexConfig, MemexOAuthProvider } = await import('@graph/shared');
  const entry = loadMemexConfig()?.mcp_servers?.[name];
  if (!entry) throw new Error(`no configured server '${name}' — run memex mcp install ${name} first`);
  if (!entry.url || entry.auth !== 'oauth') throw new Error(`server '${name}' is not an oauth http server`);

  const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js');
  const { createServer } = await import('node:http');

  // Ephemeral local callback: bind first so the redirect_uri carries the real port.
  const codePromise = { resolve: (_: string) => {}, reject: (_: Error) => {} };
  const code = new Promise<string>((resolve, reject) => {
    codePromise.resolve = resolve;
    codePromise.reject = reject;
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const c = u.searchParams.get('code');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(c ? 'Authorized — return to the terminal.' : 'Missing code parameter.');
    if (c) codePromise.resolve(c);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  try {
    const provider = new MemexOAuthProvider(name, `http://localhost:${port}/callback`, (url) =>
      openBrowser(url.toString()),
    );
    const first = await auth(provider, { serverUrl: entry.url });
    if (first === 'AUTHORIZED') {
      console.log(`already authorized — cached tokens for '${name}' are valid`);
      return;
    }
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('authorization timed out after 5 minutes')), 5 * 60 * 1000),
    );
    const authorizationCode = await Promise.race([code, timeout]);
    const second = await auth(provider, { serverUrl: entry.url, authorizationCode });
    if (second !== 'AUTHORIZED') throw new Error(`unexpected auth result: ${second}`);
    console.log(`authorized — tokens cached for '${name}'`);
  } finally {
    server.close();
  }
}

// ── command family ──────────────────────────────────────────────────────────

export async function runMcpCommand(): Promise<void> {
  const action = process.argv[3];
  const registry = new McpCatalogRegistry(catalogRoot());
  switch (action) {
    case 'catalog':
      return mcpCatalog(registry);
    case 'install':
      return mcpInstall(registry);
    case 'configure':
      return mcpConfigure(registry);
    case 'login':
      return mcpLogin();
    case 'list':
      return mcpList();
    case 'uninstall':
      return mcpUninstall();
    default:
      throw new Error('usage: memex mcp <catalog|install|configure|login|list|uninstall>');
  }
}

/** `memex mcp catalog` — list optional-mcps/ manifests + install/env status. */
async function mcpCatalog(registry: McpCatalogRegistry): Promise<void> {
  const installed = new Set(Object.keys(readRawConfig().mcp_servers ?? {}));
  const statuses = registry.statusReport(installed);
  if (statuses.length === 0) {
    console.log(`no manifests under ${catalogRoot()}`);
    return;
  }
  for (const s of statuses) {
    const flags = [
      s.installed ? 'installed' : null,
      s.missing_env.length > 0 ? `missing env: ${s.missing_env.join(', ')}` : null,
    ].filter(Boolean);
    console.log(`  ${s.name}${flags.length ? ` [${flags.join('; ')}]` : ''} — ${s.description}`);
  }
}

/** `memex mcp install <name>` — manifest → guard scan → env prompts → config + graph. */
async function mcpInstall(registry: McpCatalogRegistry): Promise<void> {
  const name = process.argv[4];
  if (!name) throw new Error('usage: memex mcp install <name>');
  const manifest = registry.get(name);
  if (!manifest) throw new Error(`no catalog manifest '${name}' under ${catalogRoot()}`);

  // Catalog content is registry content — same guard as skill installs.
  const { scanSkillContent, formatGuardReport } = await import('@graph/shared');
  const findings = scanSkillContent(registry.rawContent(name) ?? '');
  if (findings.length > 0) {
    console.log(formatGuardReport(findings));
    if (!process.argv.includes('--yes-despite-findings')) {
      console.log('\ninstall withheld — review findings, re-run with --yes-despite-findings');
      process.exit(1);
    }
  }

  await promptMissingEnv(manifest);
  const entry = manifestToConfigEntry(manifest);
  writeRawConfig(upsertServerEntry(readRawConfig(), name, entry));
  console.log(`installed: mcp_servers.${name} → ${resolveConfigPath()}`);
  if (entry.auth === 'oauth') console.log(`next: memex mcp login ${name}`);

  await recordToGraph('installed', name, {
    transport: entry.command !== undefined ? 'stdio' : 'http',
    // names only — never values (graph payloads are not a secrets store)
    requires_env: manifest.requires_env ?? [],
    guard_findings: findings.length,
  });
}

/** `memex mcp configure <name>` — re-prompt env vars + tool include/exclude. */
async function mcpConfigure(registry: McpCatalogRegistry): Promise<void> {
  const name = process.argv[4];
  if (!name) throw new Error('usage: memex mcp configure <name>');
  const cfg = readRawConfig();
  const raw = cfg.mcp_servers?.[name] as McpServerEntry | undefined;
  if (!raw) throw new Error(`no configured server '${name}'`);
  const manifest = registry.get(name);
  if (manifest) await promptMissingEnv(manifest);

  const tools = await listToolsBestEffort(name, raw);
  if (tools) {
    const { multiselect, isCancel } = await import('@clack/prompts');
    const selected = await multiselect({
      message: `tools to enable for ${name} (space to toggle)`,
      options: tools.map((t) => ({ value: t, label: t })),
      initialValues: raw.tools?.include ?? tools,
      required: false,
    });
    if (!isCancel(selected)) {
      const entry: McpServerEntry = { ...raw, tools: { include: selected as string[] } };
      writeRawConfig(upsertServerEntry(cfg, name, entry));
      console.log(`updated tools.include for '${name}' (${(selected as string[]).length} tools)`);
    }
  } else {
    console.log(`could not connect to '${name}' — tool selection skipped, env updates saved`);
  }
  await recordToGraph('configured', name, {});
}

/** `memex mcp login <name>` — OAuth PKCE flow (local callback, token cache on disk). */
async function mcpLogin(): Promise<void> {
  const name = process.argv[4];
  if (!name) throw new Error('usage: memex mcp login <name>');
  await runLogin(name);
}

/** `memex mcp list` — configured servers + connectivity. */
async function mcpList(): Promise<void> {
  const servers = readRawConfig().mcp_servers ?? {};
  const names = Object.keys(servers);
  if (names.length === 0) {
    console.log('no configured MCP servers (memex mcp catalog to browse)');
    return;
  }
  for (const name of names) {
    const entry = servers[name] as McpServerEntry;
    const transport = entry.command !== undefined ? `stdio:${entry.command}` : `http:${entry.url}`;
    const state = entry.enabled === false ? 'disabled' : await probeBestEffort(name, entry);
    console.log(`  ${name} [${state}] ${transport}${entry.auth === 'oauth' ? ' (oauth)' : ''}`);
  }
}

/** `memex mcp uninstall <name>` — remove config entry + token cache, record to graph. */
async function mcpUninstall(): Promise<void> {
  const name = process.argv[4];
  if (!name) throw new Error('usage: memex mcp uninstall <name>');
  const cfg = readRawConfig();
  if (!cfg.mcp_servers?.[name]) throw new Error(`no configured server '${name}'`);
  writeRawConfig(removeServerEntry(cfg, name));
  const { MemexOAuthProvider } = await import('@graph/shared');
  MemexOAuthProvider.deleteCache(name);
  console.log(`uninstalled: ${name} (config entry + token cache removed)`);
  await recordToGraph('uninstalled', name, {});
}

/** Prompt for manifest requires_env vars that are unset; print export hints (values are NOT persisted). */
async function promptMissingEnv(manifest: McpManifest): Promise<void> {
  const missing = (manifest.requires_env ?? []).filter((v) => !process.env[v]);
  if (missing.length === 0) return;
  const { text, isCancel, log } = await import('@clack/prompts');
  log.warn(`${manifest.name} requires env vars that are not set: ${missing.join(', ')}`);
  for (const varName of missing) {
    const value = await text({ message: `${varName} (enter to skip)`, defaultValue: '' });
    if (isCancel(value) || !value) continue;
    process.env[varName] = value as string; // session-only; config references stay ${VAR}
    log.info(`set for this session — persist it in your shell profile: ${varName}`);
  }
}

/** Try to connect and list tools; null on any failure (offline-friendly UX). */
async function listToolsBestEffort(name: string, entry: McpServerEntry): Promise<string[] | null> {
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client({ name: 'memex-cli', version: '1.0.0' });
    if (entry.command !== undefined) {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      await client.connect(
        new StdioClientTransport({
          command: entry.command,
          ...(entry.args ? { args: entry.args } : {}),
          ...(entry.env ? { env: entry.env } : {}),
        }),
      );
    } else {
      const { StreamableHTTPClientTransport } = await import(
        '@modelcontextprotocol/sdk/client/streamableHttp.js'
      );
      const { MemexOAuthProvider } = await import('@graph/shared');
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(entry.url!),
          entry.auth === 'oauth'
            ? { authProvider: new MemexOAuthProvider(name) }
            : entry.headers
              ? { requestInit: { headers: entry.headers } }
              : undefined,
        ),
      );
    }
    const tools = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return tools;
  } catch {
    return null;
  }
}

async function probeBestEffort(name: string, entry: McpServerEntry): Promise<string> {
  const tools = await listToolsBestEffort(name, entry);
  return tools ? `connected, ${tools.length} tools` : 'error';
}
