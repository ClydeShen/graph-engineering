import { readJsonSafe, writeJsonAtomic, backupIfExists } from './util.js';
import { loadMemexConfig } from '@graph/shared';

export type ClaudeCodeResult = {
  kind: 'installed' | 'already-wired';
  backup: string | null;
};

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function isAlreadyWired(cfg: ClaudeConfig | null): boolean {
  return cfg?.mcpServers?.['graph-runtime'] !== undefined;
}

export async function connectClaudeCode(opts: { force?: boolean } = {}): Promise<ClaudeCodeResult> {
  const cfgPath = `${process.env['HOME'] ?? process.env['USERPROFILE'] ?? ''}/.claude.json`;
  const existing = readJsonSafe<ClaudeConfig>(cfgPath);

  if (isAlreadyWired(existing) && !opts.force) {
    return { kind: 'already-wired', backup: null };
  }

  const backup = backupIfExists(cfgPath);
  const cfg: ClaudeConfig = existing ?? {};
  cfg.mcpServers = cfg.mcpServers ?? {};

  // Remote gateway support (Phase 15 G6/2f): env wins, then the active
  // profile's shell.gateway_url (remote Core), then the local default.
  // TLS for remote addresses is the reverse proxy's job (ADR-48 D-2).
  const base =
    process.env['GRAPH_RUNTIME_URL'] ??
    loadMemexConfig()?.shell?.gateway_url ??
    'http://localhost:4000';
  const url = base + '/mcp';
  const entry: Record<string, unknown> = { type: 'http', url };
  if (process.env['GRAPH_RUNTIME_SECRET']) {
    entry['headers'] = { Authorization: `Bearer ${process.env['GRAPH_RUNTIME_SECRET']}` };
  }

  cfg.mcpServers['graph-runtime'] = entry;
  writeJsonAtomic(cfgPath, cfg);

  return { kind: 'installed', backup };
}
