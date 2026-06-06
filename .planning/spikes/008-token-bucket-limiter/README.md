# Spike 008 — TokenBucket: limiter npm

**Status:** VALIDATED — migration NOT recommended
**Date:** 2026-06-06
**Question:** Can `limiter` npm's `TokenBucket` replace the custom 16-line `TokenBucket` in `packages/workers/src/scheduler/token-bucket.ts`?

---

## Verdict: Behavioral parity confirmed — but migration is not worth it

`limiter`'s `TokenBucket` can replicate the custom implementation's behavior with a pre-fill initialization fix. All 12 behavioral test cases pass after applying the fix.

## Critical difference discovered

`limiter.TokenBucket` **starts with an empty bucket** (`content=0`). Our custom implementation starts effectively full (`lastGrantMs=0` means any first call passes since `Date.now()-0 >= WINDOW_MS`).

This means:
- `new LimiterBucket({...}).tryRemoveTokens(1)` → **false** (bucket empty)
- `new CustomTokenBucket().tryAcquire()` → **true** (first call always allowed)

The fix: `bucket.content = bucket.bucketSize` after construction.

## API mapping required

| Custom | limiter |
|---|---|
| `new TokenBucket()` | `const b = new LimiterBucket({bucketSize:1, tokensPerInterval:1, interval:50}); b.content = b.bucketSize;` |
| `bucket.tryAcquire()` | `bucket.tryRemoveTokens(1)` |
| `bucket.reset()` | `bucket.content = bucket.bucketSize; bucket.lastDrip = 0` |

## Why migration is NOT recommended

1. **Custom implementation is 16 lines** — trivially readable and correct
2. **limiter is NOT a drop-in** — requires a wrapper class or inline initialization fix
3. **limiter adds 1 npm dependency** for zero functional gain
4. **limiter.TokenBucket** uses fractional token dripping (`dripAmount = deltaMS * (tokensPerInterval / interval)`) — more complex than our binary 50ms-window check
5. The custom implementation is correctly named and matches the ADR 31 intent

## Recommendation

**Keep the custom 16-line implementation.** The prior research gap (not checking npm before building) is real, but this is one of the cases where building custom was the right call.
