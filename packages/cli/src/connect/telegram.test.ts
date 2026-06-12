import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateBotToken, writeTelegramChannel } from './telegram.js';
import { readRawConfig } from '../mcp.js';

describe('validateBotToken', () => {
  it('returns the bot username on ok:true', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { username: 'membot' } }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(validateBotToken('1:abc', fetchFn)).resolves.toBe('membot');
  });

  it('throws when Telegram says ok:false or non-200', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false }), { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(validateBotToken('1:bad', fetchFn)).rejects.toThrow(/rejected/);
  });
});

describe('writeTelegramChannel', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memex-tg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the token REFERENCE preserving existing channel fields', () => {
    const path = join(dir, 'config.json');
    writeTelegramChannel('${TELEGRAM_BOT_TOKEN}', path);
    const cfg = readRawConfig(path) as { channels: { telegram: { token: string } } };
    expect(cfg.channels.telegram.token).toBe('${TELEGRAM_BOT_TOKEN}');
  });
});
