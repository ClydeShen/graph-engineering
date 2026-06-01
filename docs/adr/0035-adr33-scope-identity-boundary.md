# ADR 33: Scope Identity Boundary

**Status:** Accepted  
**Date:** 2026-06-01  
**Supersedes / Supplements:** ADR 23 (Nested Scope Propagation)

## Context

The system has two distinct concepts that both use Scope UUIDs: (1) the business task identity that a Scope tracks, and (2) the context window management concern of overflow and compression. Without a formal decision, there is a risk that implementation code conflates these two concepts — in particular, that context overflow (a read-time presentation concern) triggers Scope UUID rotation (a business identity event). The hermes-agent pattern of creating new scopes on context overflow (`parent_session_id` chain) is the concrete anti-pattern to be formally rejected. This decision must be locked before Phase 1 to prevent topology fragmentation in cross-task pattern matching.

## Decision

A Scope UUID tracks a logical business task unit, not a context window size. Context overflow is a read-time presentation concern handled entirely by ADR 30's sliding-window discarder. Context overflow does NOT trigger Scope UUID rotation, does NOT append any Knowledge entity to the graph, and does NOT modify graph structure in any way.

## Mechanism

### What Changes a Scope UUID (Business State Boundaries Only)

Scope UUID rotation occurs only on explicit business state boundary transitions:

| Event | Scope Transition | Mechanism |
|-------|-----------------|-----------|
| Task delegation to a sub-agent | Parent Scope → Child Scope created | `spawned_by` Hyper-edge (see ADR 34) |
| Explicit task phase transition | Current Scope closed → New Scope opened | `scope_phase_advanced` event + new `plan_created` in new Scope |
| User-initiated task restart | Current Scope closed → New Scope opened | User action triggers `scope_closed` + new Scope |

### What Does NOT Change a Scope UUID

| Event | What Happens Instead | Scope UUID |
|-------|---------------------|------------|
| Context overflow (ADR 30) | Sliding-window discarder truncates oldest events in the context view | Unchanged |
| Worker crash + restart | Worker resumes from same Scope; graph state is intact | Unchanged |
| LLM context window exhaustion | ADR 13 OOM three-level degradation chain runs | Unchanged |

### Invariant Formalization

```
f(Scope UUID)     → business task identity
f(context window) → view parameter (token budget, overflow policy)

These two functions are ORTHOGONAL.
∀ overflow_event: Scope UUID remains constant.
∀ business_boundary_event: Scope UUID may change (per the table above).
```

### Rejected Approach: Scope Rotation on Context Overflow

The hermes-agent `parent_session_id` chain creates a new scope on context overflow. This approach is permanently rejected for the following reason:

Two superficially different tasks that have the same underlying execution topology (e.g., a `debug` task and a `research` task that both follow `explore → hypothesize → validate → converge`) but different context window sizes would be fragmented into different Scope chains. Cross-task pattern matching (ADR 25, Workflow Emergence) would classify them as topologically different because the Scope fragmentation boundary falls at an arbitrary context-size artifact rather than at a business boundary. The resulting pattern library would be polluted by storage accidents masquerading as topology signals.

Formal rejection statement: **coupling storage artifacts (context window size) to business identity (Scope UUID) is architecturally incompatible with cross-domain topology pattern discovery.**

### `context_compressed` Entity is Forbidden

Appending a `context_compressed` Knowledge entity to the Execution Graph when context overflow occurs is explicitly forbidden. The Execution Graph is the append-only SSOT of business execution history. Context overflow is a presentation concern — it must not write phantom "compression events" into the causal record that do not correspond to actual business events.

## Consequences

### Positive
- Cross-task pattern matching (ADR 25 WL graph kernel) operates on business topology, not storage accidents. Pattern quality is not degraded by context window size variation.
- Scope identity is stable across the full lifetime of a business task regardless of how many context overflows occur, making long-running Scopes first-class citizens.
- Workers can always query the full graph state by Scope UUID even when their context window only contains a sliding window of recent events.

### Negative / Trade-offs
- Long-running Scopes with many events require Workers to be aware that their context window is a lossy projection — they cannot assume the context window contains the complete history. Workers that need older context must issue explicit graph queries.
- Pattern matching on very long Scopes (thousands of events) may be more expensive because the full topology is preserved in a single Scope rather than fragmented into multiple smaller ones.

## References
- ADR 13 — Knapsack Slicing + OOM three-level degradation (context overflow handling)
- ADR 23 — Nested Scope propagation (legitimate Scope creation via business boundaries)
- ADR 25 — Cross-domain topology pattern discovery (WL graph kernel; Scope fragmentation would corrupt input signal)
- ADR 30 — Context Assembly Strategy (sliding-window discarder — the correct overflow response)
- ADR 34 — Subagent Scope Branch Model (the one legitimate Scope UUID creation path at runtime)
