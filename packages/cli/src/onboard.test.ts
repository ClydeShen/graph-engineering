/**
 * onboard.test.ts — Onboarding TUI writes a valid ~/.memex/config.json
 * (Phase 11 DoD G7 unit level: prompts mocked, file output asserted).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const answers: Record<string, unknown> = {};

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn() },
  isCancel: () => false,
  select: vi.fn(() => Promise.resolve(answers['select'])),
  text: vi.fn((opts: { message: string; initialValue?: string }) =>
    Promise.resolve(answers[opts.message] ?? opts.initialValue ?? ''),
  ),
  confirm: vi.fn((opts: { message: string }) => Promise.resolve(answers[opts.message] ?? true)),
}));

import { runOnboard } from './onboard.js';
import { loadMemexConfig } from '@graph/shared';

const testDir = join(tmpdir(), `onboard-test-${process.pid}`);
const configPath = join(testDir, 'config.json');

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  for (const k of Object.keys(answers)) delete answers[k];
  answers['select'] = 'anthropic';
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('runOnboard', () => {
  it('writes a config that loadMemexConfig accepts (anthropic + ${ENV} key reference)', async () => {
    await runOnboard(configPath);

    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, 'utf8');
    // API key stored as env reference, never a literal key
    expect(raw).toContain('${ANTHROPIC_API_KEY}');

    process.env['ANTHROPIC_API_KEY'] = 'resolved-key';
    const loaded = loadMemexConfig(configPath);
    delete process.env['ANTHROPIC_API_KEY'];

    expect(loaded).not.toBeNull();
    expect(loaded!.providers![0]).toMatchObject({
      name: 'anthropic',
      type: 'anthropic',
      model: 'claude-sonnet-4-6',
      apiKey: 'resolved-key',
      priority: 1,
    });
    expect(loaded!.gateway!.port).toBe(3000);
    expect(loaded!.gateway!.websocket).toBe(true);
    expect(loaded!.gateway!.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('local provider (ollama) gets baseUrl and no apiKey', async () => {
    answers['select'] = 'ollama';
    answers['Generate a realtime API token? (required if the gateway is ever exposed beyond localhost)'] = false;
    await runOnboard(configPath);

    const loaded = loadMemexConfig(configPath);
    expect(loaded!.providers![0]).toMatchObject({
      type: 'openai-compatible',
      baseUrl: 'http://localhost:11434',
      model: 'llama3',
    });
    expect(loaded!.providers![0]!.apiKey).toBeUndefined();
    expect(loaded!.gateway!.token).toBeUndefined();
  });

  it('keeps a .bak backup when reconfiguring an existing file', async () => {
    writeFileSync(configPath, '{"gateway":{"port":1234}}', 'utf8');
    answers[`${configPath} already exists. Reconfigure? (a .bak backup is kept)`] = true;
    await runOnboard(configPath);

    expect(readFileSync(configPath + '.bak', 'utf8')).toContain('1234');
    expect(loadMemexConfig(configPath)!.gateway!.port).toBe(3000);
  });
});
