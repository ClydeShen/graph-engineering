/**
 * tiktoken Wasm tokenizer singleton for W_max budget calculation.
 *
 * IMPORTANT: `get_encoding` is called ONCE at module load time (not per request).
 * Instantiating per request would leak Wasm memory — see Pitfall 4 in RESEARCH.md.
 * This module is used ONLY for token counting to enforce the W_max context budget.
 *
 * @see ADR 14 (Context Window safety formula)
 * @see ADR 15 (Wasm Tokenizer)
 * @see ADR 30 (Context Assembly Strategy)
 */

import { get_encoding, type Tiktoken } from '@dqbd/tiktoken';

/**
 * TOKENIZER_MODE controls fallback behavior when the Wasm encoder fails to load.
 * - 'strict': rethrow the load error (current/legacy hard-fail behavior).
 * - 'estimate' (default): fall back to charCount/4 estimation, with a warning.
 *
 * Read once at module init — same singleton/module-init-only discipline as
 * the encoder itself (Pitfall 4 guard).
 */
const TOKENIZER_MODE = process.env['TOKENIZER_MODE'] === 'strict' ? 'strict' : 'estimate';

/**
 * Acquire the Wasm encoder. Called exactly once at module top-level.
 * Extracted into a function so tests can re-trigger it via vi.resetModules()
 * + vi.mock('@dqbd/tiktoken', ...) to simulate load failure.
 */
function loadEncoder(): Tiktoken | null {
  try {
    return get_encoding('cl100k_base');
  } catch (err) {
    if (TOKENIZER_MODE === 'strict') {
      throw err;
    }
    console.warn(
      '[tokenizer] Wasm load failed — using estimate mode (charCount/4). Set TOKENIZER_MODE=strict to hard-block.'
    );
    return null;
  }
}

// Singleton Wasm encoder — loaded once at module init, never per-call.
// null when TOKENIZER_MODE=estimate (default) and Wasm load failed.
const enc = loadEncoder();

// Release Wasm memory on process exit to avoid memory leak warnings.
process.on('exit', () => enc?.free());

/**
 * Count the number of tokens in a string using the cl100k_base BPE vocabulary.
 * Used exclusively for W_max budget calculation — never for LLM inference.
 *
 * NOTE: Do NOT call get_encoding() inside this function.
 * The encoder is intentionally initialised once above (Pitfall 4 guard).
 *
 * Falls back to charCount/4 estimation when the Wasm encoder failed to load
 * and TOKENIZER_MODE=estimate (default). Estimate-mode counts may deviate
 * ±15% for English text (D-09/D-10).
 */
export function countTokens(text: string): number {
  if (enc) {
    return enc.encode(text).length;
  }
  return Math.ceil(text.length / 4);
}
