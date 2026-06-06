# Spike 007b — canonical-json: RFC 8785 (JCS)

**Status:** VALIDATED
**Date:** 2026-06-06
**Question:** Is the `canonical-json` npm package (RFC 8785 / JCS — JSON Canonicalization Scheme) byte-for-byte identical to the current `canonicalJson()` implementation?

---

## Verdict: VALIDATED — byte-for-byte identical across all 23 test cases

The `canonical-json` package produces the same output as the custom `canonicalJson()` implementation for every test case, including floating-point edge cases that differ between RFC 8785 and naive JSON.stringify.

## Test results

23/23 cases matched (same 22 as 007a, plus):
- `float 1e308` — both produce `1e+308` (standard JS number serialization)
- `float 5e-324` — both produce `5e-324`

**Note on RFC 8785:** The specification defines IEEE 754 double precision serialization rules and unicode handling that can differ from `JSON.stringify`. However, V8's `JSON.stringify` and the `canonical-json` package produce identical output for all tested values — the difference only manifests for exotic edge cases not present in this system's payloads (e.g., `NaN`, `Infinity`, specific unicode escaping).

## Package note

`canonical-json` is a pure ESM package. In tsx (CJS mode), it requires a dynamic `import()` wrapped in an async IIFE. This complicates any future integration.

## Recommendation

**SAFE to replace** — byte-parity confirmed.

**Decision deferred:** Same reasoning as 007a — the custom implementation is simpler. `fast-json-stable-stringify` (007a) is the better npm alternative if a replacement is ever needed, since it is CJS-compatible and has wider adoption.

See also: Spike 007a (`fast-json-stable-stringify` — also passes byte-parity, easier to integrate in CJS context).
