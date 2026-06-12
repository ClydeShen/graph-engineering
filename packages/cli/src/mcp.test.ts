import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catalogRoot, readRawConfig, removeServerEntry, upsertServerEntry, writeRawConfig } from './mcp.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memex-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['MEMEX_CATALOG_DIR'];
});

describe('raw config editing', () => {
  it('round-trips an entry without resolving ${ENV_VAR} references', () => {
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({ gateway: { port: 4000 }, mcp_servers: {} }),
      'utf8',
    );
    const cfg = upsertServerEntry(readRawConfig(path), 'gh', {
      url: 'https://x/mcp',
      headers: { Authorization: 'Bearer ${GH_TOKEN}' },
      auth: 'oauth',
      enabled: true,
    });
    writeRawConfig(cfg, path);
    const reread = readRawConfig(path);
    // secret reference must stay a reference on disk (never resolved)
    expect((reread.mcp_servers!['gh'] as { headers: Record<string, string> }).headers).toEqual({
      Authorization: 'Bearer ${GH_TOKEN}',
    });
    // unrelated fields preserved
    expect(reread['gateway']).toEqual({ port: 4000 });
  });

  it('removeServerEntry deletes only the named entry', () => {
    const cfg = removeServerEntry(
      { mcp_servers: { a: { command: 'x' }, b: { command: 'y' } } },
      'a',
    );
    expect(Object.keys(cfg.mcp_servers!)).toEqual(['b']);
  });

  it('readRawConfig returns {} for a missing file and throws on malformed JSON', () => {
    expect(readRawConfig(join(dir, 'none.json'))).toEqual({});
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{oops', 'utf8');
    expect(() => readRawConfig(bad)).toThrow(/malformed/);
  });
});

describe('catalogRoot', () => {
  it('honours MEMEX_CATALOG_DIR override', () => {
    process.env['MEMEX_CATALOG_DIR'] = dir;
    expect(catalogRoot()).toBe(dir);
  });

  it('defaults to the repo optional-mcps directory', () => {
    expect(catalogRoot().replace(/\\/g, '/')).toMatch(/optional-mcps$/);
  });
});
