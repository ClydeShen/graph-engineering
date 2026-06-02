/**
 * TokenBucket — 50ms window throttle for the Frontier Scheduler (ADR 31).
 *
 * Prevents cascade storms: if multiple Workers complete simultaneously and
 * each emits a graph::frontier::changed event, the scheduler fires at most
 * once per WINDOW_MS regardless of how many events arrive.
 *
 * Usage:
 *   const bucket = new TokenBucket();
 *   if (!bucket.tryAcquire()) return; // too soon — skip this cycle
 *   // proceed with frontier recompute
 */

/** Minimum interval between consecutive dispatch cycles (milliseconds). */
export const WINDOW_MS = 50;

export class TokenBucket {
  private lastGrantMs = 0;

  /**
   * Returns true and records the current timestamp when enough time has passed
   * since the last grant (>= WINDOW_MS).
   * Returns false when called again within the same 50ms window.
   */
  tryAcquire(): boolean {
    const now = Date.now();
    if (now - this.lastGrantMs >= WINDOW_MS) {
      this.lastGrantMs = now;
      return true;
    }
    return false;
  }

  /** Reset the bucket (useful in tests). */
  reset(): void {
    this.lastGrantMs = 0;
  }
}
