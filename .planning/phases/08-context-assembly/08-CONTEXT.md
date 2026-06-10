# Phase 8: Context Assembly — Context

**Gathered:** 2026-06-10
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement Knapsack Slicing (ADR-13) as production-ready context assembly with an importance-stratified node-weight strategy, add CCR reversible compression as the Level-3 replacement (ADR-13 supplement), wire `@dqbd/tiktoken` with configurable fallback, and expose pipeline lifecycle hooks on `Worker` for Phase 09 Reflection Track.

The existing `knapsackSlice()` in `packages/workers/src/context/knapsack.ts` is the scaffold — Phase 08 extends it with importance stratification, CCR marker injection, and the hook layer. The three-tier context assembly (Stable → Context → Volatile) from ADR-30 is the structural frame.

Out of scope: Episodic/Semantic/Procedural memory layers (Phase 09), Ebbinghaus reinforcement (Phase 10), Dashboard/MemexTerminal shell work.

</domain>

<decisions>
## Implementation Decisions

### Knapsack Node Weighting Strategy
- **D-01:** Use **pure importance stratification** (three tiers by `event_type`, not statistical change-point detection). Directly aligns with ADR-13 without statistical infrastructure.
  - Tier 1 (highest, never dropped first): `conflict_detected`, `scope_closed`
  - Tier 2 (standard weight): all other non-repetitive event types
  - Tier 3 (aggregatable): consecutive `memory_updated` sequences — collapse repeated entries before budget calculation
- **D-02:** Extend `KnapsackConfig` with `strategy: 'newest-first' | 'importance-stratified'`. Default stays `newest-first` for backward compat; Workers opt into `importance-stratified` explicitly.

### CCR Tool Injection
- **D-03:** **Dual-channel injection** when dropped events exist: (a) inject `memex_retrieve` tool definition into the LLM `tools` array; (b) append a paragraph to the Worker's system prompt describing when to call it. The LLM gets both a structural calling interface and human-readable directional guidance.
- **D-04:** CCR sentinel format: `{"_ccr_dropped": "<<ccr:HASH N_dropped>>"}` appended to the context slice (mirrors headroom CCR sentinel pattern). `HASH` is SHA-256 of the dropped event hashes.
- **D-05:** Dropped event payloads are stored in a **in-process Map** keyed by hash during the current Worker invocation. No new DB table in Phase 08 (lightweight, invocation-scoped). Phase 09 may promote to persistent store if cross-invocation retrieval is needed.

### Pipeline Lifecycle Hooks
- **D-06:** Add **non-abstract protected methods** to the existing `Worker` abstract class (not a separate mixin). Methods default to no-op. Consistent with headroom's `CompressionHooks` base class pattern.
  - `protected onContextAssembled(ctx: PipelineContext): Promise<void>`
  - `protected onContextCompressed(ctx: PipelineContext): Promise<void>` — fired only when CCR triggers
  - `protected onLLMCalled(ctx: PipelineContext): Promise<void>`
  - `protected onResultWritten(ctx: PipelineContext): Promise<void>`
- **D-07:** `PipelineContext` carries: `scopeId`, `wMax`, `tokensBefore`, `tokensAfter`, `ccrHashes[]`, `droppedCount`. Passed read-only (no mutation from hooks).
- **D-08:** Hooks are called from the context assembly path, not from `lifecycle.ts` (the state machine). The two hook layers remain separate — ADR-27 hooks (onScheduled/onRunning/etc.) are lifecycle state; Phase 08 hooks are pipeline observability.

### Wasm Tokenizer Fallback
- **D-09:** Add `TOKENIZER_MODE` env var: `strict` (current behavior — hard throw on Wasm fail) | `estimate` (graceful fallback to `charCount / 4`). Default: `estimate` for dev environments, set to `strict` for production.
- **D-10:** Fallback logs a warning at startup (`[tokenizer] Wasm load failed — using estimate mode (charCount/4). Set TOKENIZER_MODE=strict to hard-block.`). Token counts in estimate mode may deviate ±15% for English text.

### Specimen Pattern Adaptation (headroom)
- **D-11:** SmartCrusher's Rust-backed change-point detection is **not** ported. The graph's `event_type` labels provide an equivalent semantic layer without statistical analysis. Importance stratification is the Phase 08 analog.
- **D-12:** headroom CCR uses `headroom_retrieve` as the tool name. Memex uses `memex_retrieve` — same pattern, different namespace. Tool description uses the same "hash from compression marker" language.
- **D-13:** headroom pipeline hooks have 3 stages (pre_compress / compute_biases / post_compress). Memex pipeline hooks have 4 stages (context_assembled / context_compressed / llm_called / result_written). The post-compress observational stage maps to `onContextCompressed + onLLMCalled` here — split because the LLM call itself is an observable boundary.

### Claude's Discretion
- `PipelineContext` field names and exact shape — pick what makes `onContextAssembled` useful without over-engineering.
- CCR store key format (full SHA-256 or truncated hash) — match existing `computeShortHash` convention if it exists in shared.
- Whether `countTokens` falls back transparently or requires an explicit `createTokenCounter(mode)` factory — either is fine as long as D-09 behavior is honored.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Context Assembly Core ADRs
- `docs/adr/0032-adr30-context-assembly-strategy.md` — Three-tier prompt structure (Stable→Context→Volatile), overflow policy, ReverseChronologicalDiscarder spec. **Primary structural reference.**
- `docs/adr/0024-adr13-supplement-context-oom-degradation.md` — Three-level degradation chain; Level-3 (hard suspend) is what CCR replaces in Phase 08.

### Existing Implementation (Phase 07 scaffold — READ THESE FIRST)
- `packages/workers/src/context/knapsack.ts` — `knapsackSlice()` + `KnapsackConfig` + `KnapsackSliceResult`. Phase 08 extends this file, does not replace it.
- `packages/workers/src/context/assemble.ts` — `assembleContext()` + `computeContextBudgets()` (extracted in Phase 07). Context assembly entry point.
- `packages/workers/src/context/overflow.ts` — `ReverseChronologicalDiscarder` (retained per Phase 07 decision; `ReverseChronologicalDiscarder` class stays for ADR-30 D-2 compliance, Phase 08 CCR may use it).
- `packages/shared/src/knapsack.ts` — `KnapsackGraph` interface (read-only graph accessor).
- `packages/shared/src/tokenizer.ts` — `countTokens()` singleton. Phase 08 adds TOKENIZER_MODE fallback here.
- `packages/workers/src/base/worker.abstract.ts` — `Worker` abstract class. Phase 08 adds pipeline hooks here.

### headroom Specimen (pattern reference — read for implementation guidance)
- `D:\Repo\specimens\headroom\headroom\ccr\tool_injection.py` — CCR tool definition injection pattern. Port `create_ccr_tool_definition()` shape to TypeScript as `createMemexRetrieveTool()`.
- `D:\Repo\specimens\headroom\headroom\ccr\response_handler.py` — How CCR tool call responses are routed back to the caller.
- `D:\Repo\specimens\headroom\headroom\hooks.py` — `CompressionHooks` base class pattern. Phase 08 pipeline hooks mirror this.
- `D:\Repo\specimens\headroom\headroom\transforms\pipeline.py` — `TransformPipeline` orchestration order (reference for hook call sequencing).

### Gateway Factory
- `packages/gateway/src/knapsack-graph.ts` — `makeKnapsackGraph()` factory (merged in Phase 07). Gateway adapter for `KnapsackGraph`.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `knapsackSlice()` (workers/context/knapsack.ts): Already walks the predecessor hash chain + sibling events + greedy budget pack. Phase 08 adds importance-stratified pre-sorting before the budget loop.
- `computeContextBudgets()` (workers/context/assemble.ts): Returns `{ wMax, wStable, wContext }`. Already exported as pure function — Phase 08 uses it unchanged.
- `countTokens()` (shared/tokenizer.ts): Singleton Wasm encoder. Phase 08 wraps it with TOKENIZER_MODE fallback without changing the call signature.
- `KnapsackGraph` interface (shared/knapsack.ts): Read-only graph accessor. No changes needed.

### Established Patterns
- CCR sentinel in knapsack.ts JSDoc: "Dropped events are available for Phase 08 CCR marker injection (headroom pattern — <<ccr:HASH>> sentinel)." The scaffold was built anticipating this.
- `Worker` abstract class currently has ADR-27 state machine hooks (onScheduled/onRunning/onCompleted/onFailed/onConflicted) as `abstract` methods. Pipeline hooks must be `protected` (non-abstract, no-op defaults) to avoid forcing all existing Workers to implement them.
- `ReverseChronologicalDiscarder` in overflow.ts: retained from Phase 07 for ADR-30 D-2 compliance. CCR Level-3 replacement does not delete this — it adds a CCR path that runs before Level-3 triggers.

### Integration Points
- `assembleContext()` calls `knapsackSlice()` — pipeline hooks are inserted at the boundaries around this call.
- `memex_retrieve` tool call handling: needs a route in Gateway or Worker tool router to look up CCR store by hash.
- Worker invocation path: pipeline hooks fire during `onRunning()` (the state machine hook), inside the context assembly + LLM call sequence.

</code_context>

<specifics>
## Specific Ideas

- headroom's CCR sentinel key is `_ccr_dropped` with value `"<<ccr:HASH N_rows_offloaded>>"`. Match this format exactly for `memex_retrieve` tool description clarity: `[N items compressed... hash=HASH]`.
- The `memex_retrieve` tool definition should follow the Anthropic format from headroom's `tool_injection.py` (lines 75-102): `name`, `description`, `input_schema` with `hash` (required) + `query` (optional) properties.
- Pipeline hooks should receive a `PipelineContext` that includes `ccrHashes[]` — this is what Phase 09 Reflection Track will inspect to decide whether to trigger a reflection pass.

</specifics>

<deferred>
## Deferred Ideas

- **CCR persistent store** (cross-invocation retrieval): Phase 08 uses in-process Map scoped to the current Worker invocation. Cross-invocation CCR store would require a DB table or Redis — defer to Phase 09 if Reflection Track needs it.
- **TOIN learning loop** (headroom's `toin.record_compression()` feedback to compression strategy): the feedback-driven Ebbinghaus reinforcement belongs to Phase 10-trail-discovery.
- **SmartCrusher full port** (Rust-backed change-point detection for token-dense tool outputs): headroom's Stage-3c approach is powerful but over-scoped for Phase 08. Defer until Phase 10 if profiling shows repeated `memory_updated` aggregation is insufficient.
- **Provider registry + FallbackProvider** (ROADMAP Phase 7+ item #1): no change to Phase 08 scope.

</deferred>

---

*Phase: 8-context-assembly*
*Context gathered: 2026-06-10*
