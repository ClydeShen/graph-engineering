import { readJsonSafe, writeJsonAtomic, backupIfExists } from './util.js';

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

  const url = (process.env['GRAPH_RUNTIME_URL'] ?? 'http://localhost:4000') + '/mcp';
  const entry: Record<string, unknown> = { type: 'http', url };
  if (process.env['GRAPH_RUNTIME_SECRET']) {
    entry['headers'] = { Authorization: `Bearer ${process.env['GRAPH_RUNTIME_SECRET']}` };
  }

  cfg.mcpServers['graph-runtime'] = entry;
  writeJsonAtomic(cfgPath, cfg);

  return { kind: 'installed', backup };
}
