# ADR 30: Context Assembly Strategy

**Status:** Accepted  
**Date:** 2026-06-01  
**Supplements:** ADR 13 (Knapsack Slicing), ADR 14 (Context Window Safety Formula)

## Context

ADR 13 defines the Knapsack Slicing algorithm for assembling context from the Execution Graph, but it does not address the three-tier structure of Worker prompts (stable knowledge vs. causal lineage vs. live input), nor does it define a deterministic overflow policy. Workers currently have no formal guidance on how to partition their token budget or what to do when the causal lineage projection exceeds available space. A formal strategy is needed before Phase 1 implementation begins to ensure all Workers assemble context consistently and without LLM-mediated compression.

## Decision

Each Worker invocation assembles context via three tiers (stable, context, volatile) in priority order. When the context tier overflows the token budget, a deterministic reverse-chronological sliding-window discarder runs — no LLM call, no summarization. Option B (synchronous LLM compression) is permanently abolished.

## Mechanism

### D-1: Three-Tier Prompt + Graph Augmentation

| Tier | Content | Caching | Source Query |
|------|---------|---------|-------------|
| **Stable** | Knowledge graph entities (`skill`, `schema`, `plugin_doc`, `domain_fact`) | Anthropic prompt cache — cached across invocations | `SELECT payload FROM versions WHERE entity_type = 'knowledge' AND scope_id = $global_knowledge_scope AND is_latest = true` |
| **Context** | Depth-limited causal lineage from current Scope | Per-invocation, not cached | Most recent N Hyper-edges from current Scope `ORDER BY timestamp DESC, depth ≤ D` |
| **Volatile** | Current Worker's input payload | Rebuilt every invocation | Passed directly by iii dispatcher |

Assembly order in the prompt: Stable → Context → Volatile. The Stable tier is prepended and cache-eligible; the Volatile tier is always last and always rebuilt.

The Context tier is the `Graph → Context` projection. It is assembled from the Execution Graph at invocation time. The graph is the permanent state; the context window is a read-time view of that state.

### D-2: Overflow = Three-Level Lossy Sliding-Window Discarder (Zero-LLM)

When the causal lineage projection exceeds the remaining token budget after the Stable tier is accounted for:

```
Algorithm: Reverse-Chronological Greedy Pack

Input:
  hyper_edges[]   — ordered by timestamp DESC (newest first)
  budget          — remaining tokens after Stable tier deduction

Output:
  context_slice[] — packed events, newest-first

For each edge in hyper_edges (newest → oldest):
  if tokens(edge) <= budget:
    append edge to context_slice
    budget -= tokens(edge)
  else:
    STOP — physically discard all remaining edges
```

**Three discard levels (triggered in sequence as budget shrinks):**

1. **Level 1 — Oldest ancestor trim:** Drop the oldest Hyper-edges in the lineage chain. The most recent N events are always retained.
2. **Level 2 — Sibling collapse:** If budget is still exceeded, drop sibling nodes (horizontal axis), retaining only `N_root` and `N_current`.
3. **Level 3 — Hard floor:** If even `N_root + N_current` exceeds budget, escalate to ADR 13's OOM degradation chain (not the discarder's concern — it stops here and signals overflow).

**Key invariants:**
- No LLM call is made during overflow handling. The discarder is purely deterministic.
- The most recent events are always 100% retained (greedy newest-first traversal).
- Context overflow is a read-time view behavior — it does NOT change graph structure, Scope UUID, or any Version Hash.
- The sliding window is a presentation layer concern, not a storage concern.
- `context_compressed` Knowledge entities are NOT written to the graph on overflow. The graph is immutable to this operation.
- Option B (synchronous LLM compression at overflow) is permanently abolished.
- Phase 2 extension point: the discard step may be replaced by a score-gated knapsack (Option C interface pre-reserved via `IOverflowStrategy` abstraction — unused in Phase 1).

```typescript
interface IOverflowStrategy {
  // Phase 1: ReverseChronologicalDiscarder (deterministic, zero-LLM)
  // Phase 2: ScoreGatedKnapsack (replaces discard step only)
  selectEvents(
    candidates: HyperEdge[],
    budgetTokens: number
  ): HyperEdge[];
}
```

## Consequences

### Positive
- Deterministic, reproducible context assembly — no LLM calls in the hot path means no non-deterministic overflow behavior.
- Stable tier prompt caching reduces Anthropic API costs for all Workers sharing the same global knowledge scope.
- Clear separation of concerns: storage (Execution Graph), projection (Context tier), and live input (Volatile tier) are never conflated.
- Phase 2 extension point is pre-reserved without blocking Phase 1.

### Negative / Trade-offs
- Lossy discard means older causal context is silently dropped. Workers operating on long-running Scopes may lose awareness of early-stage decisions.
- No summarization means information that would have fit in a compressed form is simply absent. The correctness burden shifts to graph queries (Workers can re-query the graph if they need older context).
- The `IOverflowStrategy` abstraction adds a layer that is unused in Phase 1.

## Supplement: Context Assembly is Read-Only — No Graph Event Written

Context assembly is a **read-time projection** (`Graph → Context`), not a cognitive advancement. It does not write a `memory_updated` event to the Execution Graph.

**Rationale:** `memory_updated` represents a cognitive state advancement (per CONTEXT.md: "Worker 执行成功，版本链向前推进"). Context assembly is infrastructure preparation — the system reading from the graph to construct the Agent's context window. Writing "I assembled context" back into the graph would conflate the projection with the state, violating the `Context as Projection` paradigm.

**Token usage data** for future task planning is already present in `payload._meta.tokens[model_fingerprint]` written by the Wasm Tokenizer on each event. No separate aggregate write is needed.

**Infrastructure telemetry** (assembly latency, token counts, overflow events) belongs in the observability layer (metrics/APM), not in the Execution Graph.

**Implementation note:** A `ContextAssemblyWorker` class was removed in Phase 2 tech-debt cleanup (commit `00013a3` + follow-up). The `graph::context-assembly` function registration that previously existed in `workers/src/index.ts` was a dead no-op — the gateway has always handled context assembly inline. Do not re-introduce a worker registration for this purpose without first resolving the `registerFunction` → `WorkerExecutionContext` architectural incompatibility.

## References
- ADR 13 — Knapsack Slicing algorithm (horizontal + vertical axes, B3 dedup)
- ADR 14 — Context Window safety capacity formula (`W_max`)
- ADR 15 — Wasm Tokenizer (token counting for greedy pack)
- ADR 27 — Worker lifecycle: Processing phase receives assembled context
- ADR 29 — Knowledge entity definition (`entity_type = 'knowledge'`, four subtypes)
