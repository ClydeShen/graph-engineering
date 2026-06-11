# Phase 8: Context Assembly — Discussion Log

**Session:** 2026-06-10
**Focus:** Specimen project learnings alignment — Phase 07/08 impact mapping

---

## Context

User requested a pre-planning alignment session to inventory what was learned from 5 specimen projects (agentmemory, hermes-agent, iii, gsd-2, headroom) and clarify what each contributes to Phase 07 (complete) and Phase 08 (next).

---

## Specimen Learning Inventory

| Specimen | Core learnings | Status |
|----------|---------------|--------|
| iii | Event bus internal, registerFunction contract, durable:subscriber trigger | ✅ Phase 03 |
| agentmemory | Worker/Tool/Connector pattern, keyed mutex, crystallize→lesson chain | ✅ Phase 03–06 |
| gsd-2 | GSD harness v2: phase management, skill orchestration | ✅ harness |
| hermes-agent | Vision: unified graph, multi-modal interaction layer | 📅 MemexShell (later) |
| headroom | SmartCrusher + CCR + lifecycle hooks + memory supersession + feedback loop | 🔜 Phase 08–10 |

## Phase 07 Architecture Work (what headroom influenced)

Phase 07 was primarily a code quality sprint, but several changes directly scaffolded Phase 08:
- `makeKnapsackGraph()` merged — single factory entry point for Phase 08 extension
- `computeContextBudgets()` extracted as pure function — Phase 08 uses unchanged
- `searchSemanticMemory()` named seam — Phase 09 extends
- `MemoryRepository` seam — Phase 09 extends

**Key discovery during discussion:** `packages/workers/src/context/knapsack.ts` already exists with a working `newest-first` knapsackSlice and an explicit "Phase 08 will add importance-stratified strategy" comment. The scaffold was built anticipating this session.

---

## Discussion Areas

### Area 1: Knapsack Slicing Granularity

**Question:** Node weight strategy — full SmartCrusher change-point detection, recency×importance composite, or pure importance stratification?

**Options presented:**
1. Pure importance stratification (three tiers by event_type) ← selected
2. recency×importance composite weight
3. Full SmartCrusher statistical analysis port

**Decision:** Pure importance stratification. Three tiers: `conflict_detected`/`scope_closed` (highest), standard events (medium), consecutive `memory_updated` sequences (aggregatable). Directly maps to ADR-13 without needing statistical infrastructure.

**Rationale:** headroom's SmartCrusher has been retired to Rust and uses content-type routing for arbitrary message arrays. Memex's event nodes have semantic labels (`event_type`) that provide equivalent discrimination without statistics.

---

### Area 2: CCR Tool Injection Method

**Question:** How should `memex_retrieve` be exposed to Workers — tools array injection, system prompt only, or both?

**Options presented:**
1. Tools array injection (headroom pattern)
2. System prompt text instructions only
3. Both ← selected

**Decision:** Dual-channel. Inject `memex_retrieve` into the LLM `tools` array (structural calling interface) AND add directional instructions to the Worker system prompt. Mirrors headroom's two-mode injection from `tool_injection.py`.

---

### Area 3: Pipeline Hooks Interface

**Question:** Base class inheritance (headroom pattern), EventEmitter subscription, or minimal single-callback?

**Options presented:**
1. Base class inheritance (headroom CompressionHooks pattern) ← selected
2. EventEmitter subscription model
3. Minimal: single `on_pipeline_event(stage, data)` method only

**Decision:** Base class inheritance. Add non-abstract `protected` methods to existing `Worker` abstract class. No-op defaults. Existing Workers need no changes.

**Rationale:** headroom's `CompressionHooks` base class with 3 specific methods is clean and well-tested. Memex's pipeline has 4 stages (context_assembled / context_compressed / llm_called / result_written) vs headroom's 3 (pre_compress / compute_biases / post_compress), but the pattern is identical.

---

### Area 4: Wasm Tokenizer Fallback

**Question:** Hard block on Wasm load failure vs graceful charCount/4 estimate vs runtime configurable?

**Options presented:**
1. charCount / 4 graceful fallback (always)
2. Hard block (Wasm must load)
3. Runtime configurable via TOKENIZER_MODE env var ← selected

**Decision:** `TOKENIZER_MODE` env var: `strict` (hard throw) | `estimate` (charCount/4 fallback). Dev default: `estimate`. Production: can be set to `strict`. Current `tokenizer.ts` is effectively `strict` today — Phase 08 adds the `estimate` path.

---

## Deferred Ideas

- CCR persistent store (cross-invocation retrieval) → Phase 09
- TOIN feedback learning loop → Phase 10
- Full SmartCrusher Rust port → Phase 10 (if profiling shows need)
