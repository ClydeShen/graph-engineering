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

import { get_encoding } from '@dqbd/tiktoken';

// Singleton Wasm encoder — loaded once at module init, never per-call.
const enc = get_encoding('cl100k_base');

// Release Wasm memory on process exit to avoid memory leak warnings.
process.on('exit', () => enc.free());

/**
 * Count the number of tokens in a string using the cl100k_base BPE vocabulary.
 * Used exclusively for W_max budget calculation — never for LLM inference.
 *
 * NOTE: Do NOT call get_encoding() inside this function.
 * The encoder is intentionally initialised once above (Pitfall 4 guard).
 */
export function countTokens(text: string): number {
  return enc.encode(text).length;
}
