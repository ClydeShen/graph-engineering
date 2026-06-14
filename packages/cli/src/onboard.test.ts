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
  note: vi.fn(),
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn(), message: vi.fn(), error: vi.fn() },
  isCancel: () => false,
  // select answers are keyed by message, with 'select' as the catch-all default
  select: vi.fn((opts: { message: string }) =>
    Promise.resolve(answers[opts.message] ?? answers['select']),
  ),
  // Mirror clack's value resolution when the user accepts the suggestion:
  // a typed answer wins, else the prefilled initialValue, else the Enter-on-empty
  // defaultValue. (placeholder is a visual hint only, never a submitted value.)
  text: vi.fn((opts: { message: string; initialValue?: string; defaultValue?: string }) =>
    Promise.resolve(answers[opts.message] ?? opts.initialValue ?? opts.defaultValue ?? ''),
  ),
  confirm: vi.fn((opts: { message: string }) => Promise.resolve(answers[opts.message] ?? true)),
  // The key is now pasted (password prompt) rather than named — default to a
  // non-empty fake so a ${VAR} reference is produced and a .env line written.
  password: vi.fn((opts: { message: string }) =>
    Promise.resolve(answers[opts.message] ?? 'test-api-key'),
  ),
  // Phase 18 prompts: presets default to none, telegram step defaults to skip
  // (per-test overrides via answers[message]).
  multiselect: vi.fn(() => Promise.resolve(answers['multiselect'] ?? [])),
  // Model listing shows a spinner around fetchModels — no-op in tests.
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
}));

import { runOnboard } from './onboard.js';
import { loadMemexConfig } from '@graph/shared';

const testDir = join(tmpdir(), `onboard-test-${process.pid}`);
const configPath = join(testDir, 'config.json');
const envPath = join(testDir, '.env');

/** Embedding is now a labelled select. These are the two message variants. */
const EMBEDDING_SELECT_REUSE = 'How should Memex create embeddings? (powers semantic memory)';
const EMBEDDING_SELECT_OTHER =
  "Anthropic (Claude) can't create embeddings — pick a provider for semantic memory";

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  // Keep the closing "is the Console live?" probe from making a real network
  // call (which could hit a dev server on :3000 and even open a browser tab).
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  for (const k of Object.keys(answers)) delete answers[k];
  answers['select'] = 'anthropic';
  // Skip optional steps in the base flow tests. The embedding select has no
  // catch-all fallback (the 'anthropic' default isn't a valid choice), so each
  // test answers the variant it triggers explicitly.
  answers['Connect a Telegram bot now? (optional)'] = false;
  answers[EMBEDDING_SELECT_OTHER] = 'skip';
  answers[EMBEDDING_SELECT_REUSE] = 'reuse';
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(testDir, { recursive: true, force: true });
});

describe('runOnboard', () => {
  it('writes a config that loadMemexConfig accepts (anthropic + ${ENV} key reference)', async () => {
    await runOnboard(configPath, envPath);

    expect(existsSync(configPath)).toBe(true);
    const raw = readFileSync(configPath, 'utf8');
    // API key stored as env reference, never a literal key
    expect(raw).toContain('${ANTHROPIC_API_KEY}');
    // The pasted key lands in .env (gitignored), never in config.json
    expect(readFileSync(envPath, 'utf8')).toContain('ANTHROPIC_API_KEY=test-api-key');
    expect(raw).not.toContain('test-api-key');

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
    answers[EMBEDDING_SELECT_OTHER] = 'other';
    answers['Embedding provider'] = 'ollama';
    await runOnboard(configPath, envPath);

    const loaded = loadMemexConfig(configPath);
    expect(loaded!.embedding).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text' });
  });

  it('local provider (ollama) gets baseUrl, no apiKey, and an auto embedding section', async () => {
    answers['select'] = 'ollama';
    answers['Protect the gateway with an access token? (only needed if you expose it beyond this computer — press Enter to skip)'] = false;
    await runOnboard(configPath, envPath);

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

  it('offers a live model pick-list when the provider lists models', async () => {
    answers['select'] = 'openai';
    // User picks a non-default model from the fetched list (proves the pick-list
    // path ran, not the text fallback which would yield the gpt-4o default).
    answers['Which model should Memex use?'] = 'gpt-4o-mini';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).includes('/models')
          ? Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] }),
            })
          : Promise.reject(new Error('offline')),
      ),
    );

    await runOnboard(configPath, envPath);

    const loaded = loadMemexConfig(configPath);
    expect(loaded!.providers![0]!.model).toBe('gpt-4o-mini');
  });

  it('allows a custom OpenAI-compatible embedding endpoint (no built-in default)', async () => {
    answers['select'] = 'anthropic'; // chat provider can't embed
    answers[EMBEDDING_SELECT_OTHER] = 'other';
    answers['Embedding provider'] = 'custom';
    answers['Embedding endpoint base URL (OpenAI-compatible)'] = 'https://api.voyageai.com/v1';
    // custom needs no model default → onboarding lists models and we pick one
    answers['Which embedding model?'] = 'voyage-3';
    // endpoint needs no key in this test → blank paste skips the .env write
    answers[
      'Paste your Custom (any OpenAI-compatible endpoint) API key — leave blank if the endpoint needs none'
    ] = '';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).includes('/models')
          ? Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ data: [{ id: 'voyage-3' }, { id: 'voyage-3-lite' }] }),
            })
          : Promise.reject(new Error('offline')),
      ),
    );

    await runOnboard(configPath, envPath);

    const loaded = loadMemexConfig(configPath);
    expect(loaded!.embedding).toMatchObject({
      provider: 'custom',
      model: 'voyage-3',
      baseUrl: 'https://api.voyageai.com/v1',
    });
  });

  it('lets a local embedding server override its port and lists models from it', async () => {
    answers['select'] = 'anthropic'; // chat provider can't embed
    answers[EMBEDDING_SELECT_OTHER] = 'other';
    answers['Embedding provider'] = 'llamacpp';
    // The user's llama.cpp embedding server runs on a non-default port/binding;
    // the local-endpoint prompt is their chance to point onboarding at it.
    answers['llama.cpp (local llama-server) endpoint URL'] = 'http://127.0.0.1:8081';
    answers['Which embedding model?'] = 'bge-m3';
    // Only the CORRECTED url answers — proves resolveBaseUrl flowed into fetchModels.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url) === 'http://127.0.0.1:8081/v1/models'
          ? Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'bge-m3' }] }) })
          : Promise.reject(new Error('offline')),
      ),
    );

    await runOnboard(configPath, envPath);

    const loaded = loadMemexConfig(configPath);
    expect(loaded!.embedding).toMatchObject({
      provider: 'llamacpp',
      model: 'bge-m3',
      baseUrl: 'http://127.0.0.1:8081', // edited endpoint persisted for runtime
    });
  });

  it('nvidia chat reuses itself for embeddings via bge-m3 (no input_type needed)', async () => {
    answers['select'] = 'nvidia';
    await runOnboard(configPath, envPath);

    process.env['NVIDIA_API_KEY'] = 'resolved';
    const loaded = loadMemexConfig(configPath);
    delete process.env['NVIDIA_API_KEY'];

    expect(loaded!.providers![0]).toMatchObject({
      name: 'nvidia',
      model: 'meta/llama-3.1-8b-instruct',
    });
    // canReuse path: NVIDIA now embeds, so it offers itself — same key, bge-m3.
    expect(loaded!.embedding).toMatchObject({ provider: 'nvidia', model: 'baai/bge-m3' });
  });

  it('reuse-embedding carries an edited local chat endpoint to the embedding section', async () => {
    answers['select'] = 'ollama';
    answers['Ollama (local) endpoint URL'] = 'http://127.0.0.1:11435'; // non-default port
    answers[
      'Protect the gateway with an access token? (only needed if you expose it beyond this computer — press Enter to skip)'
    ] = false;
    // EMBEDDING_SELECT_REUSE defaults to 'reuse' in beforeEach
    await runOnboard(configPath, envPath);

    const loaded = loadMemexConfig(configPath);
    expect(loaded!.providers![0]).toMatchObject({ baseUrl: 'http://127.0.0.1:11435' });
    // The embedding must point at the SAME edited endpoint, not the :11434 default.
    expect(loaded!.embedding).toMatchObject({
      provider: 'ollama',
      model: 'nomic-embed-text',
      baseUrl: 'http://127.0.0.1:11435',
    });
  });

  it('reuse-pick lets the user choose a different embedding model on the same provider', async () => {
    answers['select'] = 'nvidia';
    answers['Which model should Memex use?'] = 'meta/llama-3.1-8b-instruct';
    answers['How should Memex create embeddings? (powers semantic memory)'] = 'reuse-pick';
    answers['Which embedding model?'] = 'nvidia/nv-embed-v1'; // not the bge-m3 default
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        String(url).includes('/models')
          ? Promise.resolve({
              ok: true,
              json: () =>
                Promise.resolve({
                  data: [
                    { id: 'meta/llama-3.1-8b-instruct' },
                    { id: 'baai/bge-m3' },
                    { id: 'nvidia/nv-embed-v1' },
                  ],
                }),
            })
          : Promise.reject(new Error('offline')),
      ),
    );

    await runOnboard(configPath, envPath);

    process.env['NVIDIA_API_KEY'] = 'x';
    const loaded = loadMemexConfig(configPath);
    delete process.env['NVIDIA_API_KEY'];
    expect(loaded!.embedding).toMatchObject({ provider: 'nvidia', model: 'nvidia/nv-embed-v1' });
  });

  it('keeps a .bak backup when reconfiguring an existing file', async () => {
    writeFileSync(configPath, '{"gateway":{"port":1234}}', 'utf8');
    answers[`${configPath} already exists. Reconfigure? (a .bak backup is kept)`] = true;
    await runOnboard(configPath, envPath);

    expect(readFileSync(configPath + '.bak', 'utf8')).toContain('1234');
    expect(loadMemexConfig(configPath)!.gateway!.port).toBe(4000);
  });
});
