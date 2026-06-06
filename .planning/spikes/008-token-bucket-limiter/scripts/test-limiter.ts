/**
 * Spike 008 — API parity: custom TokenBucket vs limiter npm's TokenBucket
 *
 * Run: npx tsx .planning/spikes/008-token-bucket-limiter/scripts/test-limiter.ts
 *
 * Checks behavioral equivalence for the Frontier Scheduler use case (ADR 31):
 *   - At most 1 dispatch per 50ms window
 *   - First call: ALLOW
 *   - Subsequent calls in same window: DENY
 *   - After 50ms elapses: ALLOW again
 *
 * FINDING: limiter.TokenBucket starts EMPTY (content=0). Our custom starts FULL
 * (lastGrantMs=0 → Date.now()-0 >= 50 is always true on first call).
 * This means first call behavior diverges unless content is pre-filled at construction.
 *
 * The test validates behavior WITH the required initialization fix applied.
 */

import { TokenBucket as LimiterBucket } from 'limiter';

// ─── Custom implementation (verbatim from packages/workers/src/scheduler/token-bucket.ts) ─

const WINDOW_MS = 50;

class CustomTokenBucket {
  private lastGrantMs = 0;

  tryAcquire(): boolean {
    const now = Date.now();
    if (now - this.lastGrantMs >= WINDOW_MS) {
      this.lastGrantMs = now;
      return true;
    }
    return false;
  }

  reset(): void {
    this.lastGrantMs = 0;
  }
}

// ─── limiter equivalent with required initialization fix ──────────────────────
// CRITICAL: must set content=bucketSize after construction to match "starts full" behavior.
// limiter defaults to content=0 (starts empty), but our custom starts effectively full.

function makeLimiterBucket(): InstanceType<typeof LimiterBucket> {
  const b = new LimiterBucket({ bucketSize: 1, tokensPerInterval: 1, interval: WINDOW_MS });
  b.content = b.bucketSize; // ← required fix: pre-fill bucket so first call is allowed
  return b;
}

function resetLimiterBucket(b: InstanceType<typeof LimiterBucket>): void {
  b.content = b.bucketSize;
  b.lastDrip = 0; // reset lastDrip to 0 → drip() on next call will cap at bucketSize anyway
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;

function check(label: string, customResult: boolean, limiterResult: boolean): void {
  const match = customResult === limiterResult;
  const status = match ? '✓' : '✗';
  console.log(`  ${status} ${label}: custom=${customResult}, limiter=${limiterResult}${match ? '' : ' ← DIFFER'}`);
  if (match) passed++; else failed++;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log('Spike 008 — TokenBucket API parity: custom vs limiter\n');
  console.log('NOTE: limiter.TokenBucket initialized with content=bucketSize (pre-fill fix applied)\n');

  // Test 1: First call always allowed
  console.log('Test 1: First call allowed');
  {
    const custom = new CustomTokenBucket();
    const limiter = makeLimiterBucket();
    check('first tryAcquire/tryRemoveTokens', custom.tryAcquire(), limiter.tryRemoveTokens(1));
  }

  // Test 2: Second immediate call denied
  console.log('Test 2: Second call within window denied');
  {
    const custom = new CustomTokenBucket();
    const limiter = makeLimiterBucket();
    custom.tryAcquire();
    limiter.tryRemoveTokens(1);
    check('second immediate call', custom.tryAcquire(), limiter.tryRemoveTokens(1));
  }

  // Test 3: Multiple calls in window all denied
  console.log('Test 3: Multiple calls within window all denied');
  {
    const custom = new CustomTokenBucket();
    const limiter = makeLimiterBucket();
    custom.tryAcquire();
    limiter.tryRemoveTokens(1);
    for (let i = 0; i < 5; i++) {
      check(`call ${i + 2} denied`, custom.tryAcquire(), limiter.tryRemoveTokens(1));
    }
  }

  // Test 4: After 50ms, allowed again
  console.log('Test 4: Allowed after 50ms window elapses');
  {
    const custom = new CustomTokenBucket();
    const limiter = makeLimiterBucket();
    custom.tryAcquire();
    limiter.tryRemoveTokens(1);
    await sleep(WINDOW_MS + 10);
    check('after window elapsed', custom.tryAcquire(), limiter.tryRemoveTokens(1));
  }

  // Test 5: Reset restores initial state
  console.log('Test 5: reset() restores initial state');
  {
    const custom = new CustomTokenBucket();
    const limiter = makeLimiterBucket();
    custom.tryAcquire();
    limiter.tryRemoveTokens(1);
    custom.reset();
    resetLimiterBucket(limiter);
    check('first call after reset allowed', custom.tryAcquire(), limiter.tryRemoveTokens(1));
    check('second call after reset denied', custom.tryAcquire(), limiter.tryRemoveTokens(1));
  }

  // Test 6: Rapid burst — only one passes
  console.log('Test 6: Rapid burst — only first passes');
  {
    const custom = new CustomTokenBucket();
    const limiter = makeLimiterBucket();
    const customResults = Array.from({ length: 10 }, () => custom.tryAcquire());
    const limiterResults = Array.from({ length: 10 }, () => limiter.tryRemoveTokens(1));
    check('first result true', customResults[0], limiterResults[0]);
    const customAllFalse = customResults.slice(1).every((r) => !r);
    const limiterAllFalse = limiterResults.slice(1).every((r) => !r);
    check('remaining 9 all false', customAllFalse, limiterAllFalse);
  }

  // ─── API diff summary ────────────────────────────────────────────────────────

  console.log('\n── API mapping required for migration ──────────────────────────────────────');
  console.log('  custom.tryAcquire()     →  limiterBucket.tryRemoveTokens(1)');
  console.log('  custom.reset()          →  bucket.content = bucket.bucketSize; bucket.lastDrip = 0');
  console.log('  new CustomTokenBucket() →  const b = new LimiterTokenBucket({bucketSize:1, tokensPerInterval:1, interval:50})');
  console.log('                             b.content = b.bucketSize  ← must pre-fill or first call denied');

  // ─── Results ─────────────────────────────────────────────────────────────────

  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log('\n✓ VERDICT: behavioral parity confirmed (with pre-fill initialization fix)');
    console.log('  RECOMMENDATION: NOT WORTH MIGRATING — custom implementation is 16 lines and simpler.');
    console.log('  limiter adds: 1 npm dep, non-drop-in API, requires a wrapper. Zero functional gain.');
    process.exit(0);
  } else {
    console.log('\n✗ VERDICT: behavioral divergence — do not replace without investigation');
    process.exit(1);
  }
}

runTests();
