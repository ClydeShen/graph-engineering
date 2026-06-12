/**
 * onboard.test.ts — Onboarding TUI writes a valid ~/.memex/config.json
 * (Phase 11 DoD G7 unit level: prompts mocked, file output asserted).
 *
 * ADR 56: picker options derive from PROVIDER_PROFILES; an optional embedding
 * section is written (auto for embedding-capable providers, prompted otherwise).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const answers: Record<string, unknown> = {};

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn(), message: vi.fn(), error: vi.fn() },
  isCancel: () => false,
  // select answers are keyed by message, with 'select' as the catch-all default
  select: vi.fn((opts: { message: string }) =>
    Promise.resolve(answers[opts.message] ?? answers['select']),
  ),
  text: vi.fn((opts: { message: string; initialValue?: string }) =>
    Promise.resolve(answers[opts.message] ?? opts.initialValue ?? ''),
  ),
  confirm: vi.fn((opts: { message: string }) => Promise.resolve(answers[opts.message] ?? true)),
  // Phase 18 prompts: presets default to none, telegram step defaults to skip
  // (per-test overrides via answers[message]).
  multiselect: vi.fn(() => Promise.resolve(answers['multiselect'] ?? [])),
}));

import { runOnboard } from './onboard.js';
import { loadMemexConfig } from '@graph/shared';

const testDir = join(tmpdir(), `onboard-test-${process.pid}`);
const configPath = join(testDir, 'config.json');

/** The ADR-55 optional-embedding prompt for providers without an embeddings endpoint. */
const EMBEDDING_PROMPT_FRAGMENT = 'has no embeddings endpoint';

function answerEmbeddingPrompt(value: boolean | string): void {
  // confirm() message includes the provider display name — match by known prefix
  answers[
    `Anthropic (Claude) ${EMBEDDING_PROMPT_FRAGMENT}. Configure a separate one? (optional — skipping means lexical retrieval until one is added)`
  ] = value;
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  for (const k of Object.keys(answers)) delete answers[k];
  answers['select'] = 'anthropic';
  // Skip optional steps in the base flow tests.
  answers['Connect a Telegram bot now? (optional)'] = false;
  answerEmbeddingPrompt(false);
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
    // ADR 55: anthropic-only with embedding skipped → no embedding section (degraded mode)
    expect(loaded!.embedding).toBeUndefined();
    expect(loaded!.gateway!.port).toBe(4000); // DEFAULT_GATEWAY_PORT (ADR 56 D-5)
    expect(loaded!.gateway!.websocket).toBe(true);
    expect(loaded!.gateway!.token).toMatch(/^[0-9a-f]{48}$/);
  });

  it('anthropic + separate embedding provider writes an embedding section', async () => {
    answerEmbeddingPrompt(true);
    answers['Embedding provider'] = 'ollama';
    await runOnboard(configPath);

    const loaded = loadMemexConfig(configPath);
    expect(loaded!.embedding).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text' });
  });

  it('local provider (ollama) gets baseUrl, no apiKey, and an auto embedding section', async () => {
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
    // Embedding-capable profile → section derived without an extra prompt
    expect(loaded!.embedding).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text' });
  });

  it('keeps a .bak backup when reconfiguring an existing file', async () => {
    writeFileSync(configPath, '{"gateway":{"port":1234}}', 'utf8');
    answers[`${configPath} already exists. Reconfigure? (a .bak backup is kept)`] = true;
    await runOnboard(configPath);

    expect(readFileSync(configPath + '.bak', 'utf8')).toContain('1234');
    expect(loadMemexConfig(configPath)!.gateway!.port).toBe(4000);
  });
});
