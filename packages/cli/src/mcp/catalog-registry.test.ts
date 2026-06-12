import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  McpCatalogRegistry,
  McpManifestSchema,
  manifestToConfigEntry,
} from './catalog-registry.js';

let root: string;

function writeManifest(name: string, yaml: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, 'manifest.yaml'), yaml, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-catalog-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('McpManifestSchema', () => {
  it('accepts a stdio manifest', () => {
    const m = McpManifestSchema.parse({
      name: 'fs',
      description: 'files',
      transport: { command: 'npx', args: ['-y', 'server-fs'] },
    });
    expect(m.transport.command).toBe('npx');
  });

  it('accepts an http+oauth manifest', () => {
    const m = McpManifestSchema.parse({
      name: 'gh',
      description: 'github',
      transport: { url: 'https://x/mcp', auth: 'oauth' },
    });
    expect(m.transport.auth).toBe('oauth');
  });

  it('rejects both or neither transport', () => {
    expect(() =>
      McpManifestSchema.parse({ name: 'x', description: 'd', transport: {} }),
    ).toThrow();
    expect(() =>
      McpManifestSchema.parse({
        name: 'x',
        description: 'd',
        transport: { command: 'a', url: 'https://b' },
      }),
    ).toThrow();
  });

  it('rejects traversal-shaped names', () => {
    expect(() =>
      McpManifestSchema.parse({ name: '../evil', description: 'd', transport: { command: 'x' } }),
    ).toThrow();
  });
});

describe('McpCatalogRegistry', () => {
  it('lists valid manifests and skips malformed ones', () => {
    writeManifest('good', 'name: good\ndescription: ok\ntransport:\n  command: npx\n');
    writeManifest('bad', 'name: [unclosed\n');
    const reg = new McpCatalogRegistry(root);
    expect(reg.list().map((m) => m.name)).toEqual(['good']);
  });

  it('rejects a manifest whose name differs from its directory', () => {
    writeManifest('dir-a', 'name: other\ndescription: ok\ntransport:\n  command: npx\n');
    expect(new McpCatalogRegistry(root).get('dir-a')).toBeNull();
  });

  it('statusReport flags missing env and installed state', () => {
    writeManifest(
      'svc',
      'name: svc\ndescription: ok\ntransport:\n  url: https://x/mcp\nrequires_env:\n  - SVC_TOKEN_VITEST\n',
    );
    const reg = new McpCatalogRegistry(root);
    const report = reg.statusReport(new Set(['svc']), {});
    expect(report).toEqual([
      { name: 'svc', description: 'ok', missing_env: ['SVC_TOKEN_VITEST'], installed: true },
    ]);
  });

  it('returns empty list for a missing catalog root', () => {
    expect(new McpCatalogRegistry(join(root, 'nope')).list()).toEqual([]);
  });
});

describe('manifestToConfigEntry', () => {
  it('maps stdio manifest with default_enabled to tools.include', () => {
    const entry = manifestToConfigEntry(
      McpManifestSchema.parse({
        name: 'fs',
        description: 'd',
        transport: { command: 'npx', args: ['-y', 's'], env: { A: '${A}' } },
        tools: { default_enabled: ['read_file'] },
      }),
    );
    expect(entry).toEqual({
      command: 'npx',
      args: ['-y', 's'],
      env: { A: '${A}' },
      tools: { include: ['read_file'] },
      enabled: true,
    });
  });

  it('maps http+oauth manifest', () => {
    const entry = manifestToConfigEntry(
      McpManifestSchema.parse({
        name: 'gh',
        description: 'd',
        transport: { url: 'https://x/mcp', auth: 'oauth', headers: { 'X-A': 'b' } },
      }),
    );
    expect(entry).toEqual({
      url: 'https://x/mcp',
      headers: { 'X-A': 'b' },
      auth: 'oauth',
      enabled: true,
    });
  });
});
