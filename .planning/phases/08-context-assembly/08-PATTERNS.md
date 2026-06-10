# Phase 8: Context Assembly - Pattern Map

**Mapped:** 2026-06-10
**Files analyzed:** 8 (5 modified scaffold files + 3 new files)
**Analogs found:** 8 / 8 (all via in-repo Phase 07 scaffold + headroom specimen)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|----------------|
| `packages/workers/src/context/knapsack.ts` (extend) | utility/transform | transform (batch pre-sort + greedy pack) | itself (Phase 07 scaffold) | exact — extend in place |
| `packages/workers/src/context/assemble.ts` (extend) | service/pipeline | request-response (pipeline orchestration) | itself (Phase 07 scaffold) | exact — extend in place |
| `packages/workers/src/context/overflow.ts` (read, possibly reuse) | utility/transform | batch (sort + greedy discard) | itself (Phase 07 scaffold) | exact — reference only, CCR may call `discard()` |
| `packages/shared/src/tokenizer.ts` (extend) | utility/config | transform (token counting + env-driven mode) | itself (Phase 07 scaffold) | exact — add fallback wrapper |
| `packages/workers/src/base/worker.abstract.ts` (extend) | base class / lifecycle hooks | event-driven (lifecycle hook dispatch) | itself (ADR-27 abstract hooks already present) | exact — add protected no-op hooks alongside existing abstract hooks |
| `packages/gateway/src/knapsack-graph.ts` (read, no change expected) | service/factory | request-response (DB → in-memory adapter) | itself (Phase 07, merged) | exact — used unchanged by knapsackSlice/assembleContext |
| `packages/workers/src/context/ccr.ts` (NEW) | utility/service | transform + pub-sub-ish (in-process Map store + tool definition) | `D:\Repo\specimens\headroom\headroom\ccr\tool_injection.py` (cross-language) + `packages/shared/src/content-fingerprint.ts` (hash convention) | role-match (cross-language port) |
| `packages/workers/src/context/pipeline-context.ts` or inline in `assemble.ts`/`worker.abstract.ts` (NEW type) | type/interface | n/a (data carrier) | `D:\Repo\specimens\headroom\headroom\hooks.py` (`CompressEvent`/`CompressContext` dataclasses) | role-match (cross-language port) |

## Pattern Assignments

### `packages/workers/src/context/knapsack.ts` (utility, transform — extend in place)

**Analog:** itself (current scaffold, lines 1-103)

**Current exports** (lines 17-32):
```typescript
export type { KnapsackGraph };

/** Events kept within budget and events dropped beyond it. */
export interface KnapsackSliceResult {
  kept: EventLogNode[];
  dropped: EventLogNode[];
}

/**
 * Algorithm configuration for knapsackSlice.
 * Extensible: add new strategy values without changing call sites.
 * Phase 08 will add 'smart-crusher' (headroom SmartCrusher pattern).
 */
export interface KnapsackConfig {
  strategy?: 'newest-first';
}
```
**Phase 08 change (D-02):** Add `'importance-stratified'` to the `strategy` union. Per CONTEXT.md D-02, this is additive — `'newest-first'` stays the default for backward compat:
```typescript
export interface KnapsackConfig {
  strategy?: 'newest-first' | 'importance-stratified';
}
```
Note: D-11 supersedes the `'smart-crusher'` JSDoc placeholder on line 28 — that strategy is NOT ported. Update/remove that comment when editing (it references a strategy value that will never exist).

**Core pattern — candidate assembly + greedy pack** (lines 59-103):
```typescript
// --- Vertical axis: walk predecessor_hash chain to N_root ---
const causalChain: EventLogNode[] = [];
let currentHash = rootHash;

while (currentHash && currentHash !== ZERO_HASH) {
  const event = graph.getEventByHash(currentHash);
  if (!event) break;
  causalChain.push(event);
  currentHash = event.predecessor_hash;
}

// --- Horizontal axis: add sibling events (pending / conflict_detected) ---
const siblings = graph.getSiblings(scopeId, rootHash);
const siblings_sorted = [...siblings].sort(
  (a, b) => b.created_at.getTime() - a.created_at.getTime()
);

// Merge: causal chain first (higher priority), then siblings
const candidates = [...causalChain, ...siblings_sorted];

// --- Budget: greedy newest-first pack up to wMax ---
const kept: EventLogNode[] = [];
const dropped: EventLogNode[] = [];
let budget = wMax;
let budgetExhausted = false;

for (const event of candidates) {
  if (budgetExhausted) {
    dropped.push(event);
    continue;
  }
  const tokens = countTokens(event.payload);
  if (tokens > budget) {
    budgetExhausted = true;
    dropped.push(event);
  } else {
    kept.push(event);
    budget -= tokens;
  }
}

return { kept, dropped };
```

**Phase 08 insertion point for D-01 (importance stratification):**
Insert a pre-sort/pre-aggregate step between `candidates` construction (line 79) and the budget loop (line 87), gated by `_config?.strategy === 'importance-stratified'`:
- Tier 1 (`conflict_detected`, `scope_closed`): sort first, never displaced by budget exhaustion ordering.
- Tier 2: all other non-repetitive `event_type`s — current newest-first order.
- Tier 3: collapse consecutive `memory_updated` runs into a single representative entry before token counting (D-01 "aggregatable").

Use `event.event_type` (typed as `CanonicalEventType` from `@shared/types` — already imported transitively via `EventLogNode`) for tier classification — no new import needed beyond what's already at line 12.

**`_config` parameter** is currently prefixed with underscore (unused, line 57) — Phase 08 will consume it; rename to `config` when implementing the stratified branch (surgical: only this rename, don't touch the `newest-first` default path's untouched lines).

---

### `packages/workers/src/context/assemble.ts` (service/pipeline — extend in place)

**Analog:** itself (current scaffold, lines 1-117)

**Imports pattern** (lines 17-19):
```typescript
import type { EventLogNode } from '@shared/types';
import { countTokens } from '@shared/tokenizer';
import { knapsackSlice, type KnapsackGraph } from './knapsack.js';
```
Phase 08 additions will likely need: `import type { KnapsackSliceResult } from './knapsack.js';` (to access `.dropped` for CCR) and a new import from the new `ccr.ts` module (e.g. `import { buildCcrSentinel, createMemexRetrieveTool } from './ccr.js';`).

**Core pipeline pattern — `assembleContext()`** (lines 90-117):
```typescript
export async function assembleContext(
  graph: KnapsackGraph,
  scopeId: string,
  rootHash: string,
  currentInput: unknown,
  wMax: number,
  scopeClosed = false
): Promise<AssembledContext> {
  const stable = STABLE_SYSTEM_ROLE;
  const volatile = JSON.stringify(currentInput);

  // scope_closed: signal Agent to terminate (ADR 24).
  if (scopeClosed) {
    return { stable, context: null, volatile };
  }

  const stableTokens = countTokens(stable);
  const volatileTokens = countTokens(volatile);
  const { forKnapsack: contextBudget } = computeContextBudgets({ wMax, stableTokens, volatileTokens });

  // Layer 2: Knapsack causal lineage projection
  // dropped is available for Phase 08 CCR marker injection; ignored here (ADR 13 supplement)
  const contextEvents = (await knapsackSlice(graph, scopeId, rootHash, contextBudget)).kept;

  return { stable, context: contextEvents, volatile };
}
```

**Phase 08 insertion points:**
1. **Capture `.dropped`** from `knapsackSlice()` (currently discarded at line 114 — `.kept` only). When `dropped.length > 0`, this is where CCR sentinel injection (D-04) and the in-process Map store (D-05) get populated — call into `ccr.ts` here.
2. **`AssembledContext` interface** (lines 25-35) likely needs new optional fields for CCR metadata (e.g. `ccrHashes?: string[]`) so `processAgentTurn` (gateway) can pass them through to `PipelineContext`. Keep additive — `context: EventLogNode[] | null` and `stable`/`volatile` stay unchanged for ADR 24 compatibility.
3. **Pipeline hooks (D-06/D-08)** are called from the path that *uses* `assembleContext()` — i.e., inside a Worker's `onRunning()`, not inside `assembleContext()` itself (per D-08, hooks are pipeline observability, separate from the context-assembly pure function). `assembleContext()` itself likely stays a pure function; the hook-calling wrapper may be a new thin function in this file or directly in the calling Worker.

**`computeContextBudgets()` — used unchanged** (lines 61-69):
```typescript
export function computeContextBudgets(params: {
  wMax: number;
  stableTokens: number;
  volatileTokens: number;
}): { forKnapsack: number } {
  return {
    forKnapsack: Math.max(0, params.wMax - params.stableTokens - params.volatileTokens),
  };
}
```
Per CONTEXT.md "Reusable Assets": no changes needed to this function.

---

### `packages/shared/src/tokenizer.ts` (utility/config — extend in place)

**Analog:** itself (current scaffold, lines 1-31, full file — small, single read)

**Current implementation (full file):**
```typescript
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
```

**Phase 08 change (D-09/D-10):**
- The `get_encoding('cl100k_base')` call at module load (line 16) is the point that can throw on Wasm load failure. Wrap in try/catch at module init:
  - `strict` mode (current behavior): rethrow / hard-fail.
  - `estimate` mode (new default): catch, set `enc = null`, log the warning string from D-10 verbatim: `[tokenizer] Wasm load failed — using estimate mode (charCount/4). Set TOKENIZER_MODE=strict to hard-block.`
- `countTokens(text)` becomes: if `enc` is non-null, `enc.encode(text).length` (unchanged); else `Math.ceil(text.length / 4)`.
- `process.on('exit', () => enc.free())` (line 19) must guard against `enc === null`.
- Read `process.env.TOKENIZER_MODE` once at module load (singleton pattern — same module-init-only constraint as `get_encoding`, per the existing Pitfall 4 JSDoc warning at lines 4-5 and 25-26). Default to `'estimate'` per D-09.
- No call-signature change to `countTokens(text: string): number` — Claude's Discretion note says transparent fallback is fine; this preserves all call sites (`knapsack.ts` line 92, `overflow.ts` line 39, `assemble.ts` lines 107-108) unchanged.

---

### `packages/workers/src/base/worker.abstract.ts` (base class — add protected hooks)

**Analog:** itself (current scaffold, lines 1-76, full file — small, single read) + cross-language pattern from `D:\Repo\specimens\headroom\headroom\hooks.py`

**Current structure (full file):**
```typescript
import type { GraphHandle } from './graph-handle.js';

export interface WorkerExecutionContext {
  scopeId: string;
  entityId: string;
  currentVersionHash: string;
  graph: GraphHandle;
  input: unknown;
}

export abstract class Worker {
  abstract onScheduled(ctx: WorkerExecutionContext): Promise<void>;
  abstract onRunning(ctx: WorkerExecutionContext): Promise<void>;
  abstract onCompleted(ctx: WorkerExecutionContext): Promise<void>;
  abstract onFailed(ctx: WorkerExecutionContext, error: Error): Promise<void>;
  abstract onConflicted(ctx: WorkerExecutionContext): Promise<void>;
}
```

**Phase 08 change (D-06/D-07):** Add four `protected` (NOT `abstract`) no-op methods to the `Worker` class, following the headroom `CompressionHooks` no-op-default pattern:

headroom analog (`hooks.py` lines 73-151) — note the doc comment convention to copy:
```python
class CompressionHooks:
    """Base class for compression hooks. Override methods to customize.

    All methods have no-op defaults — OSS behavior is unchanged unless
    a subclass is provided via ProxyConfig(hooks=MyHooks()).
    """

    def pre_compress(self, messages, ctx) -> list[dict[str, Any]]:
        """..."""
        return messages
    ...
    def post_compress(self, event: CompressEvent) -> None:
        """Called after compression completes. Observational only."""
        pass
```

TypeScript port shape (additive to `worker.abstract.ts`, alongside the existing `abstract` ADR-27 hooks — D-08 keeps the two hook layers separate, both live on `Worker` but are conceptually distinct):
```typescript
export interface PipelineContext {
  scopeId: string;
  wMax: number;
  tokensBefore: number;
  tokensAfter: number;
  ccrHashes: string[];
  droppedCount: number;
}

export abstract class Worker {
  // --- ADR-27 lifecycle state machine hooks (existing, abstract) ---
  abstract onScheduled(ctx: WorkerExecutionContext): Promise<void>;
  abstract onRunning(ctx: WorkerExecutionContext): Promise<void>;
  abstract onCompleted(ctx: WorkerExecutionContext): Promise<void>;
  abstract onFailed(ctx: WorkerExecutionContext, error: Error): Promise<void>;
  abstract onConflicted(ctx: WorkerExecutionContext): Promise<void>;

  // --- Phase 08 pipeline observability hooks (new, non-abstract no-op) ---
  /** Fired after assembleContext() produces a slice. No-op by default. */
  protected async onContextAssembled(ctx: PipelineContext): Promise<void> {}
  /** Fired only when CCR triggers (dropped events exist). No-op by default. */
  protected async onContextCompressed(ctx: PipelineContext): Promise<void> {}
  /** Fired after the LLM call returns. No-op by default. */
  protected async onLLMCalled(ctx: PipelineContext): Promise<void> {}
  /** Fired after the Worker writes its result to the graph. No-op by default. */
  protected async onResultWritten(ctx: PipelineContext): Promise<void> {}
}
```

**Important — read-only contract (D-07):** "Passed read-only (no mutation from hooks)" — TypeScript has no runtime enforcement for this like `Readonly<T>` would only be a compile hint; if the planner wants to enforce it, type the hook parameter as `Readonly<PipelineContext>` (with `ccrHashes: readonly string[]`). This is additive typing only — no behavior change.

**Where hooks fire (D-08, integration point):** Per CONTEXT.md "Integration Points" — hooks fire inside a Worker's `onRunning()` (the ADR-27 Processing-phase hook), around the `assembleContext()` call. This is NOT inside `lifecycle.ts`'s `runLifecycle()` driver (read at `packages/workers/src/base/lifecycle.ts` lines 135-180) — that driver only orchestrates the four ADR-27 abstract hooks and must NOT be touched for Phase 08's pipeline hooks.

---

### `packages/workers/src/context/ccr.ts` (NEW — utility/service, transform)

**Analog:** `D:\Repo\specimens\headroom\headroom\ccr\tool_injection.py` (cross-language port) + `packages/shared/src/content-fingerprint.ts` (hash convention)

**Hash convention to reuse** (`packages/shared/src/content-fingerprint.ts`, full file):
```typescript
import { createHash } from 'node:crypto';

// Compute a hex-encoded SHA-256 fingerprint of content.
// Used as content_hash in event payloads (audit trail) and as fingerprintId for lesson dedup.
export function contentFingerprint(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
```
D-04 specifies "SHA-256 of the dropped event hashes" — `contentFingerprint()` from `@shared/content-fingerprint` is the existing SHA-256 utility; reuse it for the CCR sentinel hash rather than calling `node:crypto` directly (matches "Claude's Discretion" note re: matching existing hash conventions). Note: `@shared` does NOT currently export a `computeShortHash` — `contentFingerprint` returns the full 64-char hex digest. Truncation (if desired) is a new design choice, not an existing convention.

**Anthropic tool definition shape to port** (`tool_injection.py` lines 75-102, the `provider == "anthropic"` branch):
```python
elif provider == "anthropic":
    return {
        "name": CCR_TOOL_NAME,
        "description": (
            "Retrieve original uncompressed content that was compressed to save tokens. "
            "Use this when you need more data than what's shown in compressed tool results. "
            "The hash is provided in compression markers like [N items compressed... hash=abc123]."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "hash": {
                    "type": "string",
                    "description": "Hash key from the compression marker (e.g., 'abc123' from hash=abc123)",
                },
                "query": {
                    "type": "string",
                    "description": (
                        "Optional search query to filter results. "
                        "If provided, only returns items matching the query. "
                        "If omitted, returns all original items."
                    ),
                },
            },
            "required": ["hash"],
        },
    }
```

TypeScript port shape (per D-03, D-12, "specifics" section):
```typescript
export const MEMEX_RETRIEVE_TOOL_NAME = 'memex_retrieve';

export interface AnthropicToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export function createMemexRetrieveTool(): AnthropicToolDefinition {
  return {
    name: MEMEX_RETRIEVE_TOOL_NAME,
    description:
      'Retrieve original uncompressed content that was compressed to save tokens. ' +
      'Use this when you need more data than what\'s shown in the compressed context. ' +
      'The hash is provided in compression markers like [N items compressed... hash=HASH].',
    input_schema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: "Hash key from the compression marker (e.g. 'HASH' from hash=HASH)" },
        query: { type: 'string', description: 'Optional search query to filter results. If omitted, returns all original items.' },
      },
      required: ['hash'],
    },
  };
}
```

**CCR sentinel format (D-04)** — exact shape specified in CONTEXT.md:
```typescript
// Appended to the context slice when dropped events exist:
{ "_ccr_dropped": "<<ccr:HASH N_dropped>>" }
```
where `HASH = contentFingerprint(dropped.map(e => e.version_hash).join('|'))` (or similar deterministic join — exact join strategy is Claude's Discretion per CONTEXT.md, but must be deterministic over the dropped set).

**In-process Map store (D-05)** — pattern: module-scoped or per-invocation `Map<string, EventLogNode[]>` keyed by the sentinel HASH, populated when `assembleContext()` (or its caller) detects `dropped.length > 0`. No DB table — invocation-scoped per D-05. Look at how other in-process caches are scoped: `packages/gateway/src/knapsack-graph.ts` lines 66-69 builds a per-call `Map<string, EventLogNode>` (`eventCache`) that is local to the factory invocation, not module-global:
```typescript
const eventCache = new Map<string, EventLogNode>();
for (const row of rows) {
  eventCache.set(row.version_hash, row);
}
```
This is the closest in-repo analog for "in-process Map scoped to current invocation" — the CCR store should follow the same per-invocation (not module-global singleton) scoping to avoid cross-scope leakage between concurrent Worker invocations.

**Dual-channel injection (D-03)** — system-prompt paragraph append, port from `tool_injection.py` `create_system_instructions()` (lines 133-165):
```python
def create_system_instructions(hashes, retrieval_endpoint="/v1/retrieve") -> str:
    hash_list = ", ".join(hashes) if len(hashes) <= 5 else f"{', '.join(hashes[:5])} ..."
    return f"""
## Compressed Context Available

Some tool outputs have been compressed to reduce context size. If you need
the full uncompressed data, you can retrieve it using the `{CCR_TOOL_NAME}` tool.

**How to retrieve:**
- Call `{CCR_TOOL_NAME}(hash="<hash>")` to get all original items
- Call `{CCR_TOOL_NAME}(hash="<hash>", query="search terms")` to search within

**Available hashes:** {hash_list}
"""
```
Port to a `createMemexRetrieveInstructions(hashes: string[]): string` function appended to `STABLE_SYSTEM_ROLE` (from `assemble.ts` lines 44-49) — but note D-01/ADR-30 D-1 says the stable layer "MUST remain stable across invocations" for prompt caching. Appending a per-invocation hash list to the stable string would break cache-eligibility. **Flag for planner:** the CCR system-prompt paragraph likely belongs in a new non-cached portion of the prompt (or the Layer 3 volatile section), not appended to `STABLE_SYSTEM_ROLE` directly — this is a design tension the plan should resolve explicitly.

---

## Shared Patterns

### Singleton/module-init guard pattern (tokenizer)
**Source:** `packages/shared/src/tokenizer.ts` lines 4-5, 15-16, 25-26
**Apply to:** `packages/shared/src/tokenizer.ts` TOKENIZER_MODE change
```typescript
// Singleton Wasm encoder — loaded once at module init, never per-call.
const enc = get_encoding('cl100k_base');
// NOTE: Do NOT call get_encoding() inside this function.
// The encoder is intentionally initialised once above (Pitfall 4 guard).
```
The TOKENIZER_MODE env read and the try/catch around `get_encoding()` must follow this same "once at module init" discipline — re-reading `process.env.TOKENIZER_MODE` per-call or re-attempting `get_encoding()` per-call would violate the existing Pitfall-4 guard convention.

### No-op protected hook pattern (pipeline hooks)
**Source:** `D:\Repo\specimens\headroom\headroom\hooks.py` lines 73-151 (`CompressionHooks`)
**Apply to:** `packages/workers/src/base/worker.abstract.ts` — the four new D-06 hooks
- All four hooks default to empty async no-op bodies.
- JSDoc on each documents "Called when X. No-op by default. Override to customize."
- Existing ADR-27 hooks remain `abstract` (forced implementation); new hooks are `protected` non-abstract (optional override) — this distinction is the core of D-06's "non-abstract protected methods... to avoid forcing all existing Workers to implement them."

### Read-only graph projection invariant
**Source:** `packages/workers/src/context/knapsack.ts` lines 2-10, `packages/workers/src/context/assemble.ts` lines 1-15, `packages/workers/src/context/overflow.ts` lines 1-9
**Apply to:** All Phase 08 context/ files (knapsack.ts, assemble.ts, ccr.ts)
```typescript
/**
 * Graph → Context is a ONE-WAY projection; this module never writes to the graph.
 */
```
Every file in `packages/workers/src/context/` carries this invariant in its header JSDoc. The new `ccr.ts` file should carry the same header — the in-process Map store (D-05) is an in-memory side structure, not a graph write, so the invariant still holds.

### Pure-function exports for independent unit testing
**Source:** `packages/workers/src/context/assemble.ts` lines 51-69 (`computeContextBudgets`)
```typescript
/**
 * Pure function — no side effects. Exported for independent unit testing.
 */
export function computeContextBudgets(params: {...}): {...} { ... }
```
Apply this convention to new Phase 08 helper functions in `ccr.ts` (e.g. `createMemexRetrieveTool()`, sentinel-formatting functions) — export as pure functions for unit testing in isolation, following the `computeContextBudgets` precedent.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/workers/src/context/ccr.ts` (in-process Map store portion) | service/cache | event-driven | No existing invocation-scoped cache pattern beyond the per-call `eventCache` in `knapsack-graph.ts` (which is a one-shot lookup map, not a write-then-retrieve store). The retrieve-by-hash tool-call routing (D-03 "Integration Points": `memex_retrieve` tool call handling needs a route in Gateway or Worker tool router) has no existing analog — `packages/workers/src/base/tool.interface.ts` defines the `Tool` interface shape but no concrete tool implementations exist yet in `packages/workers/src/` to copy from. Use `Tool<TInput, TOutput>` interface (lines 30-46) as the structural shape for the `memex_retrieve` tool's `execute()` handler, but the routing/registration mechanism itself is novel. |
| `packages/workers/src/context/pipeline-context.ts` (if split into its own file) | type/interface | n/a | `PipelineContext` is a new data-carrier type; closest cross-language analog is headroom's `CompressEvent`/`CompressContext` dataclasses (`hooks.py` lines 40-70), which have no direct TS interface counterpart in this repo yet. Planner should decide whether `PipelineContext` lives inline in `worker.abstract.ts` (co-located with the hooks that use it) or in a new dedicated file — `AssembledContext` in `assemble.ts` (lines 25-35) is the closest in-repo precedent for "small interface co-located with its producing function." |

## Metadata

**Analog search scope:** `packages/workers/src/context/`, `packages/workers/src/base/`, `packages/shared/src/`, `packages/gateway/src/`, `D:\Repo\specimens\headroom\headroom\ccr\`, `D:\Repo\specimens\headroom\headroom\hooks.py`
**Files scanned:** 12 (7 in-repo target/analog files, 1 EventLogNode type definition, 1 lifecycle.ts, 1 tool.interface.ts, 2 headroom specimen files)
**Pattern extraction date:** 2026-06-10
