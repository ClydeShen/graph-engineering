import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMemexConfig, resolveConfigPath, activeProfile, profileDir, memexHome } from './loader.js';

const testDir = join(tmpdir(), `loader-test-${process.pid}`);

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  delete process.env['TEST_MEMEX_KEY'];
});

describe('loadMemexConfig', () => {
  it('returns null when the file does not exist', () => {
    expect(loadMemexConfig(join(testDir, 'nonexistent.json'))).toBeNull();
  });

  it('returns null when the file contains malformed JSON', () => {
    const filePath = join(testDir, 'bad.json');
    writeFileSync(filePath, '{ not valid json', 'utf8');
    expect(loadMemexConfig(filePath)).toBeNull();
  });

  it('returns the parsed config when the file is valid', () => {
    const filePath = join(testDir, 'config.json');
    const config = {
      gateway: { port: 4000, websocket: true },
      providers: [
        { name: 'primary', type: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6', priority: 1 },
      ],
      channels: { telegram: { token: 'bot-token', home_channel: 'telegram:123' } },
    };
    writeFileSync(filePath, JSON.stringify(config), 'utf8');
    const result = loadMemexConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.gateway!.port).toBe(4000);
    expect(result!.gateway!.websocket).toBe(true);
    expect(result!.providers![0]!.name).toBe('primary');
    expect(result!.channels!['telegram']!.home_channel).toBe('telegram:123');
  });

  it('replaces ${ENV_VAR} placeholders from process.env before parsing', () => {
    process.env['TEST_MEMEX_KEY'] = 'secret-key-123';
    const filePath = join(testDir, 'config.json');
    writeFileSync(
      filePath,
      JSON.stringify({ gateway: { port: 4000, token: '${TEST_MEMEX_KEY}' } }),
      'utf8',
    );
    const result = loadMemexConfig(filePath);
    expect(result!.gateway!.token).toBe('secret-key-123');
  });

  it('unresolved env vars become empty strings (still valid JSON)', () => {
    const filePath = join(testDir, 'config.json');
    writeFileSync(
      filePath,
      JSON.stringify({ gateway: { port: 4000, token: '${DOES_NOT_EXIST_XYZ}' } }),
      'utf8',
    );
    const result = loadMemexConfig(filePath);
    expect(result!.gateway!.token).toBe('');
  });

  it('accepts Phase 12 forward-contract slots (webhook.hmac_secret, shell.gateway_url)', () => {
    const filePath = join(testDir, 'config.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        webhook: { hmac_secret: 'shh' },
        shell: { gateway_url: 'http://localhost:4000' },
      }),
      'utf8',
    );
    const result = loadMemexConfig(filePath);
    expect(result!.webhook!.hmac_secret).toBe('shh');
    expect(result!.shell!.gateway_url).toBe('http://localhost:4000');
  });

  it('returns null when a provider entry fails validation', () => {
    const filePath = join(testDir, 'config.json');
    writeFileSync(
      filePath,
      JSON.stringify({ providers: [{ name: 'x' }] }), // missing type/model/priority
      'utf8',
    );
    expect(loadMemexConfig(filePath)).toBeNull();
  });

  // ── Profiles (Phase 15 G5) ─────────────────────────────────────────────────

  describe('profile resolution', () => {
    afterEach(() => {
      delete process.env['MEMEX_PROFILE'];
    });

    it('MEMEX_PROFILE=x resolves profiles/x/config.json; unset resolves top-level', () => {
      delete process.env['MEMEX_PROFILE'];
      expect(resolveConfigPath()).toBe(join(memexHome(), 'config.json'));
      expect(activeProfile()).toBeNull();

      process.env['MEMEX_PROFILE'] = 'staging';
      expect(activeProfile()).toBe('staging');
      expect(profileDir()).toBe(join(memexHome(), 'profiles', 'staging'));
      expect(resolveConfigPath()).toBe(join(memexHome(), 'profiles', 'staging', 'config.json'));
    });

    it('rejects traversal-shaped profile names and falls back to default', () => {
      for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', '']) {
        process.env['MEMEX_PROFILE'] = bad;
        expect(activeProfile()).toBeNull();
        expect(resolveConfigPath()).toBe(join(memexHome(), 'config.json'));
      }
    });

    it('accepts the Phase 15 database isolation slot', () => {
      const filePath = join(testDir, 'config.json');
      writeFileSync(
        filePath,
        JSON.stringify({ database: { url: 'postgres://localhost:5432/memex_staging' } }),
        'utf8',
      );
      const result = loadMemexConfig(filePath);
      expect(result!.database!.url).toBe('postgres://localhost:5432/memex_staging');
    });
  });
});
