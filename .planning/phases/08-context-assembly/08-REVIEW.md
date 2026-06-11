---
phase: 08-context-assembly
reviewed: 2026-06-10T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - packages/shared/src/tokenizer.ts
  - packages/shared/src/tokenizer.test.ts
  - packages/workers/src/context/knapsack.ts
  - packages/workers/src/context/knapsack.test.ts
  - packages/workers/src/base/worker.abstract.ts
  - packages/workers/src/base/worker.abstract.test.ts
  - packages/workers/src/context/ccr.ts
  - packages/workers/src/context/ccr.test.ts
  - packages/workers/src/context/assemble.ts
  - packages/workers/src/context/assemble.test.ts
findings:
  critical: 0
  warning: 5
  info: 3
  total: 8
status: issues_found
---

# Phase 08: Code Review Report

**Reviewed:** 2026-06-10T00:00:00Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Reviewed 10 source files implementing Phase 08 context assembly: the Wasm tokenizer singleton, the knapsack greedy slicer, the CCR (Compressed Context Retrieval) machinery, the Worker abstract base class pipeline hooks, and the 3-layer prompt assembler. The Wasm memory management in `tokenizer.ts` is correctly handled (the `@dqbd/tiktoken` v1.0.22 `encode()` method frees WASM allocations internally before returning — no leak). The core algorithmic logic across `knapsack.ts`, `ccr.ts`, and `assemble.ts` is structurally sound. However, five warnings were found: two concerning contradictory or misleading LLM-facing text (a wrong sentinel format in the tool description and a stale system role that contradicts CCR instructions), two correctness issues in `assemble.ts` (circular-input crash and silent budget overrun), and one observability design defect where `tokensBefore`/`tokensAfter` in `PipelineContext` measure incomparable quantities.

---

## Warnings

### WR-01: CCR Tool Description References Wrong Sentinel Format

**File:** `packages/workers/src/context/ccr.ts:103-106`
**Issue:** `createMemexRetrieveTool()` sets the `description` field to include the phrase `compression markers like [N items compressed... hash=HASH]`. This copies headroom's format string verbatim. The actual sentinel injected into the context by `buildCcrSentinel` is `<<ccr:HASH N_dropped>>` — a completely different format with a different positional ordering of hash and count. When an LLM consults the tool description to understand where to find hash values, it is told to look for `[N items compressed... hash=HASH]` but it will see `<<ccr:abc123... 5_dropped>>`. The LLM must independently realize the formats differ, increasing the chance it misreads the sentinel or fails to locate the hash at all. The `createMemexRetrieveInstructions` function partially mitigates this by listing hashes directly in the prompt, but the tool description remains factually wrong.

**Fix:**
```typescript
export function createMemexRetrieveTool(): AnthropicToolDefinition {
  return {
    name: MEMEX_RETRIEVE_TOOL_NAME,
    description:
      'Retrieve original uncompressed content that was compressed to save tokens. ' +
      "Use this when you need more data than what's shown in the compressed context. " +
      'The hash is provided in compression markers like <<ccr:HASH N_dropped>> ' +
      '(e.g. <<ccr:abc123... 3_dropped>> → pass hash="abc123...").',
    // ...
  };
}
```

---

### WR-02: STABLE_SYSTEM_ROLE Contradicts CCR Instructions When Drops Occur

**File:** `packages/workers/src/context/assemble.ts:98-101`
**Issue:** `STABLE_SYSTEM_ROLE` contains: `"Context overflow is handled by the sliding-window discarder — older events are dropped, not summarized. Retrieve older context via graph queries if needed."` This text was written before Phase 08 CCR was introduced. Now when drops occur, the LLM receives two contradictory retrieval instructions in the same assembled prompt:

1. **Stable layer (cached):** "older events are dropped … retrieve via graph queries."
2. **CCR instructions (non-cached, dynamic):** "Some events have been compressed … use `memex_retrieve`."

An LLM receiving both will either pick one arbitrarily, attempt both, or be uncertain. If it follows the stable layer (higher recency in training: "use graph queries"), it will not call `memex_retrieve` and the entire CCR design fails. Additionally, "sliding-window discarder" is factually wrong for Phase 08 — the actual mechanism is a greedy knapsack pack. A separate but related problem: the stable role says events "are dropped, not summarized," which conflicts with the CCR framing of "compressed."

**Fix:** Update `STABLE_SYSTEM_ROLE` to describe the actual Phase 08 mechanism and avoid contradicting the CCR directional channel:
```typescript
export const STABLE_SYSTEM_ROLE =
  'You are a graph-native agent operating on an append-only Execution Graph. ' +
  'Your context window is a read-time projection of the graph state. ' +
  'All persistent writes occur through the GraphHandle write interface only. ' +
  'Context overflow is handled by a token-budget greedy slicer — older events ' +
  'beyond the budget are excluded from this context slice. ' +
  'Excluded events may be retrievable via the memex_retrieve tool when indicated.';
```

---

### WR-03: `tokensBefore` and `tokensAfter` in PipelineContext Measure Incomparable Quantities

**File:** `packages/workers/src/context/assemble.ts:241, 254-260`
**Issue:** In `runContextAssemblyPipeline()`:

```typescript
const tokensBefore = countTokens(JSON.stringify(currentInput)); // volatile input ONLY
// ...
const tokensAfter = result.context != null
  ? countTokens(JSON.stringify(result.context))  // Layer 2 events ONLY
  : 0;
```

`tokensBefore` is the token count of the volatile input (Layer 3) alone — it does not include the stable system role (Layer 1) or any existing context events. `tokensAfter` is the token count of the assembled Layer 2 context array — it does not include stable or volatile. A `PipelineContext` consumer (e.g., Phase 09 Reflection Track using `onContextAssembled`) would naturally interpret `tokensBefore` as "total tokens before compression" and `tokensAfter` as "total tokens after compression." That interpretation is wrong for both values. A consumer computing a compression ratio from these fields would get a meaningless number (e.g., volatile=1 token before, context=400 tokens after → "compression increased tokens 400x"). The test comment at line 212 acknowledges this asymmetry ("tokensBefore is the volatile input count; tokensAfter is the assembled context count") but the field names on the exported interface do not communicate this.

**Fix (option A — rename for accuracy):**
```typescript
// Rename fields and document clearly
const pipelineCtx: PipelineContext = {
  // ...
  volatileTokens: tokensBefore,    // tokens in current input payload
  contextLayerTokens: tokensAfter, // tokens in assembled Layer 2 (events + sentinel)
  // ...
};
```

**Fix (option B — measure consistently):**
```typescript
// tokensBefore = total context token count before knapsack
const tokensBefore = countTokens(JSON.stringify({
  stable,
  context: /* all events pre-knapsack */,  // would require pre-slice count
  volatile,
}));
```
Option A is cheaper; option B is semantically correct but requires the pre-slice event count.

---

### WR-04: `JSON.stringify(currentInput)` Can Throw on Circular Input

**File:** `packages/workers/src/context/assemble.ts:156, 241`
**Issue:** `currentInput` is typed as `unknown`. Both call sites serialize it with `JSON.stringify()` without a guard:

- Line 156: `const volatile = JSON.stringify(currentInput);`
- Line 241 (in `runContextAssemblyPipeline`): `const tokensBefore = countTokens(JSON.stringify(currentInput));`

If a caller passes an object with circular references (e.g., a Node.js error object, or any object with a `parent` back-pointer), both lines throw `TypeError: Converting circular structure to JSON`. Since `assembleContext` and `runContextAssemblyPipeline` are `async`, this rejects the returned Promise rather than crashing synchronously, but no caller is tested with this input shape, and there is no documentation that circular inputs are disallowed. Worker subclasses supply `input: unknown` (from `WorkerExecutionContext.input`) which can be anything.

**Fix:**
```typescript
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    // Fallback for circular references or non-serializable values.
    return JSON.stringify(String(value));
  }
}

// Then replace both JSON.stringify(currentInput) calls with safeStringify(currentInput).
```

---

### WR-05: No Guard When `stableTokens + volatileTokens` Exceeds `wMax`

**File:** `packages/workers/src/context/assemble.ts:116-119, 164-166`
**Issue:** `computeContextBudgets` clamps `forKnapsack` to 0 via `Math.max(0, ...)`, but does not signal when `stableTokens + volatileTokens >= wMax`. In this case `forKnapsack = 0`, so every event is dropped to CCR. The assembled context is returned containing:

- `stable` (stableTokens tokens — already at or beyond `wMax`)
- `context` with the CCR sentinel (a few additional tokens)
- `volatile` (volatileTokens tokens)

The total token count of the assembled prompt exceeds `wMax` before any Layer 2 events are added. The function's JSDoc says `wMax` is the "Maximum token budget for the entire assembled prompt" — that contract is silently violated. No warning is logged and no error is thrown.

**Fix:** Add a defensive check and log a warning when the invariant is violated:
```typescript
const stableTokens = countTokens(stable);
const volatileTokens = countTokens(volatile);
const { forKnapsack: contextBudget } = computeContextBudgets({ wMax, stableTokens, volatileTokens });

if (stableTokens + volatileTokens > wMax) {
  console.warn(
    `[assembleContext] stable (${stableTokens}) + volatile (${volatileTokens}) = ` +
    `${stableTokens + volatileTokens} exceeds wMax (${wMax}). ` +
    `All context events will be dropped to CCR and the assembled prompt will exceed budget.`
  );
}
```

---

## Info

### IN-01: `(worker as unknown as HookCaller)` Bypasses TypeScript Access Control

**File:** `packages/workers/src/context/assemble.ts:268, 272`
**Issue:** The `HookCaller` local type alias is used to call `protected` hooks from outside the class via a double cast. This is documented as the intentional "friend" pattern (D-08). The compile-time risk is that if `Worker.onContextAssembled` or `Worker.onContextCompressed` signatures change, the call sites in `assemble.ts` will not produce a TypeScript error — the break would be silent at compile time and surface as a runtime mismatch or test failure. The `HookCaller` interface would need to be manually kept in sync with the `Worker` class.

**Fix:** Document the interface explicitly with a comment that it must mirror `Worker`'s protected hooks, or consider a narrower public-facing dispatch method on `Worker` that internally delegates to the protected hooks.

---

### IN-02: `process.on('exit', ...)` Accumulates Per Test Import in tokenizer.test.ts

**File:** `packages/shared/src/tokenizer.test.ts:5-10` / `packages/shared/src/tokenizer.ts:49`
**Issue:** The `beforeEach` hook calls `vi.resetModules()`, and each test that imports `./tokenizer.js` runs `process.on('exit', () => enc?.free())` (line 49 of tokenizer.ts) again — one listener per import. With 4 tests doing dynamic imports, 3–4 exit listeners are added per test run. This is currently below Node.js's default `MaxListeners` threshold (10), so no warning fires. However, if more tests are added (or the test suite is run in a shared process with other tests registering exit listeners), this could trigger "MaxListenersExceededWarning". The strict-mode test at line 21 rejects the import before `process.on` is reached, so it does not add a listener.

**Fix:** Not required now (below threshold), but if tests grow, add `process.setMaxListeners(process.getMaxListeners() + 1)` before the import or use `process.once('exit', ...)` and re-register after module reset. Alternatively, restructure `tokenizer.ts` to register the listener only once via a module-level guard.

---

### IN-03: No Deduplication Between Causal Chain and Sibling Events

**File:** `packages/workers/src/context/knapsack.ts:76-82`
**Issue:** `getSiblings(scopeId, rootHash)` excludes only `rootHash`. Any causal-chain event other than `rootHash` (i.e., archived events that are also in the causal chain) could theoretically be returned by a `KnapsackGraph` implementation as a sibling, causing duplicates in `candidates`. Duplicates would consume budget twice and appear twice in `kept`. The real implementation in `packages/gateway/src/knapsack-graph.ts` filters by status (`pending_scheduling / pending_dispatch / conflict_detected`) which does not overlap with archived causal-chain events — so the risk is limited to violating implementations. No deduplication is performed in the merge step.

**Fix (defensive):** Add deduplication after the merge if defence-in-depth is desired:
```typescript
const seenHashes = new Set(causalChain.map((e) => e.version_hash));
const uniqueSiblings = siblings_sorted.filter((e) => !seenHashes.has(e.version_hash));
const candidates = [...causalChain, ...uniqueSiblings];
```

---

_Reviewed: 2026-06-10T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
