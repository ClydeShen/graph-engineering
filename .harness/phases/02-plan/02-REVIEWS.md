---
phase: 2
reviewers: [gemini, claude-self-analysis]
reviewed_at: 2026-06-04T00:00:00Z
plans_reviewed: [02-PLAN.md tasks 16–18]
review_scope: Tech debt tasks #20 (canonicalJson), #21 (dead context-assembly), #22 (process.env consolidation)
notes: opencode invoked but operates in interactive agent mode only — no non-interactive output produced
---

# Cross-AI Plan Review — Phase 02 (Tasks 16–18)

## Gemini Review

The following is a review of implementation plans for **Tasks 16, 17, and 18** within the Phase 2 Architecture Backlog of the Graph-Native Agent Runtime project.

### 1. Summary
The proposed task set successfully addresses critical technical debt related to data integrity (ADR 02), system simplification (Task 17), and configuration security/testability (ADR 22). Task 16 is a high-precision fix for a fundamental invariant. Task 17 forces a decision on a speculative architectural component that currently exists as a "zombie" registration. Task 18 moves the codebase toward a more mature dependency injection pattern, which is essential for multi-environment stability and unit testing.

### 2. Strengths
- **Invariant Enforcement:** Task 16 directly secures the deterministic hashing mechanism (`version_hash`), which is the backbone of the system's causal chain.
- **Architectural Cleanup:** Task 17 correctly identifies a "no-op" that adds cognitive load and potential confusion regarding the authority of context assembly.
- **Improved Testability:** Task 18's shift toward boot-time injection will allow for easier mocking of database pools and LLM providers in integration tests.
- **Precision:** The acceptance criteria for Task 16 are specific down to the location, minimizing the risk of missing a critical infra-write path.

### 3. Concerns

#### HIGH SEVERITY
- **Task 17: Telemetry Regression:** If `ContextAssemblyWorker` is removed, the system loses the `memory_updated` event that records context assembly metadata (token counts, event counts). While the Gateway handles the assembly inline for performance, it currently lacks the "infra-write" right to record this assembly metadata back to the graph. Removing the worker without adding this write to the Gateway (or a background task) means context assembly becomes an "invisible" transient process, contradicting the philosophy that "Memory, workflow, context, and state are all views of the same append-only event graph."
- **Task 18: Import Blast Radius:** `ddlPool` and `readPool` are currently exported as constants and imported by multiple core modules in `control-plane`. Transitioning these to injected parameters will require a significant refactor of constructors and function signatures across the package. The "2 context window" estimate might be optimistic if the chain of dependencies is deep.

#### MEDIUM SEVERITY
- **Task 16: Count Discrepancy:** The "What to build" description mentions **5** `JSON.stringify` calls, but the Acceptance Criteria lists **6** locations (including `context-assembly.worker.ts`). A developer relying on the summary text risks missing the 6th location.
- **Task 18: Incomplete Env Consolidation:** The plan focuses on DB pools but overlooks `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` reads in gateway and workers, which also violate ADR 22 and should be part of the same consolidation pass.

#### LOW SEVERITY
- **Task 16: Volatile Layer:** `assembleContext` may use `JSON.stringify` for the volatile layer of the LLM prompt (not an infra-write). While not hash-critical, canonicalizing there would maximise prompt-cache hit rates (ADR 30).

### 4. Suggestions
- **Task 16:** Update the count to **6** locations. Add a note clarifying that `context-assembly.worker.ts`'s `canonical_json_text` field in `ctx.graph.write()` is the most semantically critical of the 6.
- **Task 17:** Resolve with one explicit decision before implementation: if the project requires context assembly events to be discoverable from the execution graph (which is consistent with the project vision), **wire** the worker; if context assembly is intentionally an ephemeral computation with no graph trace, **remove** it but document that omission explicitly in ADR 30.
- **Task 18:** Introduce a typed `Config` interface in each package populated in `index.ts`. Include LLM provider config and `startPulseFetch`'s subscriber alongside DB pools — partial consolidation leaves the invariant only partially enforced.

### 5. Risk Assessment
**Level: MEDIUM**

**Justification:** Task 18's refactor touches a wide import surface area in `control-plane`. Task 17 carries an architectural risk if the "remove" path is taken without preserving graph auditability. Task 16 is low risk but high correctness impact — a single missed call silently breaks hash determinism.

---

## Claude Self-Analysis

*Independent review from the model executing this session, based on direct code inspection.*

### 1. Summary
Tasks 16–18 are well-scoped and correctly prioritised. The acceptance criteria are precise. The main risk is the open decision in Task 17 — the plan is ambiguous on whether to remove or wire, and that ambiguity makes the task HITL rather than AFK.

### 2. Strengths
- Task 16 has zero ambiguity: `canonicalJson` is already exported and available in all three packages. All 6 locations are identifiable by grep. No architectural decision required.
- Task 17 explicitly presents both options and lists confirmation checks for each path — good.
- Task 18's acceptance criteria include the `GRAPH_AGENT_CHILD_SCOPE` carve-out, which shows awareness of Phase 4 interdependence and avoids premature cleanup.

### 3. Concerns

#### HIGH SEVERITY
- **Task 17: HITL status not declared.** The plan offers two mutually exclusive paths (wire vs. remove) without a decision criterion. An agent executing this task would need to choose. The current implementation gap — the worker does `void contextAssemblyWorker; return payload;` — tells us the worker was never intended to be invoked via this path. The `ContextAssemblyWorker` lifecycle is invoked via `ctx.graph.write()` which comes from `GraphHandle`, not from the `registerFunction` raw payload path. The two paths are architecturally incompatible: `registerFunction` gets raw `payload: unknown`, not a `WorkerExecutionContext`. Wiring would require either a `WorkerExecutionContext` adaptor or a rewrite. Removing is the safer, lower-risk option — the gateway handles context assembly inline.
- **Task 16: Hash migration concern.** Any existing `version_hash` values in the database that were computed with `JSON.stringify({ scope_id: scopeId })` (key order: natural insertion order) will now hash differently from the same payload serialized with `canonicalJson({ scope_id: scopeId })`. For single-key objects this is identical. For `{ scope_id, reason }` (two keys), `canonicalJson` sorts keys alphabetically: `{ "reason": ..., "scope_id": ... }` — which differs from the current `{ "scope_id": ..., "reason": ... }` natural order. This means existing `context_oom_throttled` predecessor hashes in the DB will NOT match newly computed hashes. No migration is planned. The AC should explicitly address this — either confirm it's acceptable (these events are chain-terminal, no descendant events use their hash as predecessor) or add a note.

#### MEDIUM SEVERITY
- **Task 18: `read-pool.ts` in control-plane.** The control-plane package exports both `ddlPool` and `readPool` as module-level singletons using `process.env.DATABASE_URL`. After this refactor, callers of `readPool` (e.g., `pulse-fetch.ts`) will need a new import path. The AC doesn't list all call sites that will need updating.

#### LOW SEVERITY
- **Task 16: `context-assembly.worker.ts:83` — object key order.** The object `{ worker, stable_tokens, context_events, scope_closed }` — `canonicalJson` would produce `{ "context_events": ..., "scope_closed": ..., "stable_tokens": ..., "worker": ... }`. This is internally consistent and correct per ADR 02 but differs from the natural key order. Just confirming this is expected behaviour.

### 4. Suggestions
- **Task 17:** Declare this HITL. The plan should make the "remove" path the default (simpler, lower blast radius, no `WorkerExecutionContext` adaptor required) unless the project explicitly requires context assembly events in the graph (which is not currently in any ADR). Add a line to ADR 30 supplement noting that context assembly is intentionally ephemeral.
- **Task 16:** Add AC: "Confirm `{ scope_id, reason }` → `canonicalJson` key order change is acceptable for chain-terminal events (no existing hashes used as predecessor)." For new schemas this is fine; documenting the intent protects future reviewers.
- **Task 18:** Generate a complete list of `process.env` read sites before implementation. The current plan lists 4 sites but likely more exist in gateway.

### 5. Risk Assessment
**Level: MEDIUM**

Task 17 is the highest execution risk due to the open architecture decision. Task 16 is safe except for the key-order behaviour change in two-key payloads that should be acknowledged. Task 18's blast radius is wider than the acceptance criteria implies.

---

## Consensus Summary

### Agreed Strengths
- Task 16 is well-specified and mechanically straightforward — both reviewers agree this is low-risk, high-correctness-impact work.
- Task 18's approach toward boot-time injection is architecturally correct and improves testability.
- The carve-out for `GRAPH_AGENT_CHILD_SCOPE` as Phase 4 deferred is a good boundary decision.

### Agreed Concerns (highest priority)

1. **Task 17 is HITL** — the plan does not provide a decision criterion for "wire vs. remove." Both reviewers flag this independently. Recommended resolution: **remove** (lower risk, gateway handles inline assembly, no `WorkerExecutionContext` adaptor needed). Requires a note added to ADR 30.

2. **Task 16 count discrepancy** — "5 locations" in description but 6 in AC. Both reviewers flag this. Fix: update the description to say 6 and explicitly mark `context-assembly.worker.ts` as a `canonical_json_text` field in `graph.write()` (the most semantically critical instance).

3. **Task 18 blast radius** — Both reviewers flag that the scope is wider than the AC states. LLM provider config and additional gateway env reads should be included or explicitly deferred.

4. **Task 16 key-order change for two-key payloads** (Claude self-analysis) — `{ scope_id, reason }` currently serializes with `scope_id` first; `canonicalJson` will sort to `reason` first. Confirm this is safe for chain-terminal events.

### Divergent Views

- Gemini focuses on telemetry loss risk from removing `ContextAssemblyWorker` (HIGH severity). Claude self-analysis focuses on the architectural incompatibility that makes wiring harder than it looks (the `registerFunction` path receives `payload: unknown`, not `WorkerExecutionContext`). Both point to "remove" as the correct path for different reasons.

---

## Recommended Plan Amendments Before Execution

| Task | Amendment |
|------|-----------|
| 16 | Fix count: 5 → 6 locations in description. Add AC confirming key-order change acceptable for chain-terminal events. |
| 17 | Declare HITL. Default to "remove" path. Add AC: "ADR 30 supplement notes context assembly is intentionally ephemeral (no graph trace)." |
| 18 | Audit all `process.env` read sites before starting. Include LLM config in scope or explicitly defer with a follow-up issue. |
