import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMemexConfig } from './loader.js';

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
    const result = loadMemexConfig(join(testDir, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null when the file contains malformed JSON', () => {
    const filePath = join(testDir, 'bad.json');
    writeFileSync(filePath, '{ not valid json', 'utf8');
    const result = loadMemexConfig(filePath);
    expect(result).toBeNull();
  });

  it('returns the parsed config when the file is valid', () => {
    const filePath = join(testDir, 'config.json');
    const config = {
      gateway: { port: 4000 },
      providers: [
        { name: 'primary', type: 'anthropic', apiKey: 'test-key', model: 'claude-sonnet-4-6', priority: 1 },
      ],
      channels: { telegram: { token: 'bot-token' } },
    };
    writeFileSync(filePath, JSON.stringify(config), 'utf8');
    const result = loadMemexConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.gateway!.port).toBe(4000);
    expect(result!.providers![0]!.name).toBe('primary');
    expect(result!.channels).toEqual({ telegram: { token: 'bot-token' } });
  });

  it('replaces ${ENV_VAR} placeholders from process.env before parsing', () => {
    process.env['TEST_MEMEX_KEY'] = 'secret-key-123';
    const filePath = join(testDir, 'config.json');
    const raw = JSON.stringify({
      providers: [
        { name: 'primary', type: 'anthropic', apiKey: '${TEST_MEMEX_KEY}', model: 'claude-sonnet-4-6', priority: 1 },
      ],
    });
    writeFileSync(filePath, raw, 'utf8');
    const result = loadMemexConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.providers![0]!.apiKey).toBe('secret-key-123');
  });

  it('replaces unresolved ${ENV_VAR} with empty string when env var is not set', () => {
    delete process.env['UNDEFINED_VAR_XYZ'];
    const filePath = join(testDir, 'config.json');
    const raw = JSON.stringify({
      providers: [
        { name: 'primary', type: 'anthropic', apiKey: '${UNDEFINED_VAR_XYZ}', model: 'claude-sonnet-4-6', priority: 1 },
      ],
    });
    writeFileSync(filePath, raw, 'utf8');
    const result = loadMemexConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.providers![0]!.apiKey).toBe('');
  });

  it('returns null when Zod validation fails (port is a string)', () => {
    const filePath = join(testDir, 'config.json');
    // gateway.port must be a number, not a string
    writeFileSync(filePath, JSON.stringify({ gateway: { port: 'not-a-number' } }), 'utf8');
    const result = loadMemexConfig(filePath);
    expect(result).toBeNull();
  });

  it('returns config with gateway.port as number, providers as array, channels as record', () => {
    const filePath = join(testDir, 'config.json');
    const config = {
      gateway: { port: 3000 },
      providers: [
        { name: 'fallback', type: 'ollama', baseUrl: 'http://localhost:11434', model: 'llama3', priority: 2 },
      ],
      channels: { discord: { token: 'disc-token' } },
    };
    writeFileSync(filePath, JSON.stringify(config), 'utf8');
    const result = loadMemexConfig(filePath);
    expect(result).not.toBeNull();
    expect(typeof result!.gateway!.port).toBe('number');
    expect(Array.isArray(result!.providers)).toBe(true);
    expect(typeof result!.channels).toBe('object');
  });
});
