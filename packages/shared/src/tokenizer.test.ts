import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_TOKENIZER_MODE = process.env['TOKENIZER_MODE'];

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.doUnmock('@dqbd/tiktoken');
});

afterEach(() => {
  if (ORIGINAL_TOKENIZER_MODE === undefined) {
    delete process.env['TOKENIZER_MODE'];
  } else {
    process.env['TOKENIZER_MODE'] = ORIGINAL_TOKENIZER_MODE;
  }
});

describe('countTokens — TOKENIZER_MODE fallback', () => {
  it('strict mode rethrows when Wasm load fails', async () => {
    process.env['TOKENIZER_MODE'] = 'strict';
    vi.doMock('@dqbd/tiktoken', () => ({
      get_encoding: () => {
        throw new Error('wasm load failed');
      },
    }));

    await expect(import('./tokenizer.js')).rejects.toThrow('wasm load failed');
  });

  it('estimate mode falls back to charCount/4 when Wasm load fails', async () => {
    process.env['TOKENIZER_MODE'] = 'estimate';
    vi.doMock('@dqbd/tiktoken', () => ({
      get_encoding: () => {
        throw new Error('wasm load failed');
      },
    }));

    const { countTokens } = await import('./tokenizer.js');
    expect(countTokens('abcd')).toBe(1);
  });

  it('default (unset) mode uses the real encoder when Wasm load succeeds', async () => {
    delete process.env['TOKENIZER_MODE'];

    const { countTokens } = await import('./tokenizer.js');
    // Real cl100k_base encoder — 'abcd' is a single BPE token.
    expect(countTokens('abcd')).toBe(1);
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });

  it('estimate-mode fallback logs the exact warning string once at module init', async () => {
    process.env['TOKENIZER_MODE'] = 'estimate';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.doMock('@dqbd/tiktoken', () => ({
      get_encoding: () => {
        throw new Error('wasm load failed');
      },
    }));

    await import('./tokenizer.js');

    expect(warnSpy).toHaveBeenCalledWith(
      '[tokenizer] Wasm load failed — using estimate mode (charCount/4). Set TOKENIZER_MODE=strict to hard-block.'
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
