# Spike 007a — canonical-json: fast-json-stable-stringify

**Status:** VALIDATED
**Date:** 2026-06-06
**Question:** Is `fast-json-stable-stringify` byte-for-byte identical to the current `canonicalJson()` implementation?

---

## Verdict: VALIDATED — byte-for-byte identical across all 22 test cases

`fast-json-stable-stringify` (FSS) produces the same output as the custom `canonicalJson()` implementation for every test case tested, including edge cases.

## Test results

22/22 cases matched:
- Flat objects with unsorted keys
- Nested objects at arbitrary depth
- Arrays of primitives and objects (order preserved)
- All JSON primitives (string, number, boolean, null)
- Empty object `{}` and empty array `[]`
- Unicode strings (Chinese, accented characters)
- Special characters (quotes, backslash)
- `-0` (both produce `0` via JSON.stringify semantics)
- Mixed nested types
- Real-world version hash payload shape
- `Object.create(null)` (prototype-less objects)

## Why this matters

`canonicalJson()` is used in `hashablePayload()` to produce the `canonical_json_text` passed to PostgreSQL's `pgcrypto digest()`. Any divergence would produce different `version_hash` values — breaking the append-only hash chain for all existing graph data.

Byte-parity means the library is a safe drop-in replacement.

## Recommendation

**SAFE to replace** — the custom `canonicalJson()` can be replaced by `fast-json-stable-stringify` with no hash chain impact.

**Decision deferred:** The custom implementation is 7 lines and has no maintenance burden. Replacement adds 1 npm dependency for minimal gain. Recommend keeping the custom implementation unless `fast-json-stable-stringify` is needed for another reason.

See also: Spike 007b (RFC 8785 `canonical-json` package — also passes byte-parity).
