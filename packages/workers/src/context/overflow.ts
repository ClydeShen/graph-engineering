/**
 * Context overflow strategy — Zero-LLM reverse-chronological sliding window.
 *
 * Graph → Context is a ONE-WAY projection. This module performs NO graph mutations.
 * No context_compressed entity is ever written. No LLM call is ever made here.
 *
 * @see ADR 30 D-2 (Overflow = Three-Level Lossy Sliding-Window Discarder)
 * @see ADR 33 D-6 (Scope UUID never rotated on overflow)
 */

import type { EventLogNode } from '@shared/types';
import { countTokens } from '@shared/tokenizer';

/**
 * Zero-LLM reverse-chronological greedy pack discarder.
 *
 * Algorithm (ADR 30 D-2):
 *   1. Sort events newest-first (by created_at DESC).
 *   2. Accumulate countTokens(payload) greedily until the next event
 *      would exceed wMax.
 *   3. Stop — physically discard all remaining (older) events.
 *
 * Invariants:
 *   - No LLM call. No summarization. Purely deterministic.
 *   - Graph structure is NEVER mutated. context_compressed is NEVER written.
 *   - Most recent events are always retained first.
 */
export class ReverseChronologicalDiscarder {
  discard(candidates: EventLogNode[], wMax: number): EventLogNode[] {
    // Sort newest-first
    const sorted = [...candidates].sort(
      (a, b) => b.created_at.getTime() - a.created_at.getTime()
    );

    const result: EventLogNode[] = [];
    let budget = wMax;

    for (const event of sorted) {
      const tokens = countTokens(event.payload);
      if (tokens > budget) {
        // Next event would exceed budget — stop (oldest events are dropped).
        break;
      }
      result.push(event);
      budget -= tokens;
    }

    return result;
  }
}
