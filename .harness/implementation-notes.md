# Implementation Notes — Graph-Native Agent Runtime

Decisions and deviations from the spec that the implementer should know.
Updated incrementally — append only.

---

## OCC event_type column always 'memory_updated' (D1)

**File:** `packages/shared/src/sql/occ-writable-cte.sql.ts`
**ADR ref:** ADR 11

All agent writes via the OCC Writable CTE store `event_type='memory_updated'` in the DB column, regardless of the `event_type` field submitted by the external agent (`task_spawned` or `memory_updated`). The submitted event_type is merged into the payload JSON before being stored.

DB column semantics:
- `plan_created` — Control Plane DDL nesting
- `memory_updated` — all agent writes (first-writer OCC winner)
- `conflict_detected` — OCC loser (causal inversion, atomic rewrite)
- `scope_closed` — Gateway inline Watchdog convergence write
- `task_spawned` — allowed by CHECK constraint but never written by any code path

Payload JSON semantics: `payload.event_type` carries the client-submitted semantic type.

**Impact:** TESTING-PLAN Gate 1 Scenario B DB verification shows `memory_updated` in row 2, not `task_spawned`. Updated in TESTING-PLAN.md accordingly.

---

## context_oom_throttled stored as memory_updated (D6) — RESOLVED

**File:** `packages/gateway/src/watchdog-sql.ts` — `writeContextOomThrottled()`
**ADR ref:** ADR 24, ADR 38

When context assembly OOM is triggered (Tier 3 degradation), the Gateway writes an event with:
- `event_type = 'memory_updated'` (DB column — identification requires payload inspection)
- `payload = { scope_id, reason: 'context_oom_throttled' }` (identification field)
- `status = 'suspended'` (**not** `terminated` — see ADR 38)

`status='suspended'` blocks the Convergence Watchdog SQL (`status NOT IN ('terminated', 'archived')`), preventing a partially-converged OOM scope from receiving `scope_closed`. The original `status='terminated'` was a bug: it caused the Watchdog to treat an OOM-interrupted scope as cleanly converged. Fixed in commit after `0ca9efe`.

---

## LLMProvider/EmbeddingProvider location (D3)

**File:** `packages/workers/src/llm/provider.interface.ts`
**ADR ref:** REQ-21

LLMProvider and EmbeddingProvider interfaces are in the workers package. REQ-21 specifies the "iii-engine layer" abstraction should be accessible from the shared package. Move to `packages/shared/src/llm/` in Phase 2 before any other package needs to import these interfaces.

---

## Tool write() guard is compile-time only (D4)

**File:** `packages/workers/src/base/tool.interface.ts`
**ADR ref:** ADR 35 D-8

The Tool ABC enforces `ReadOnlyGraphHandle` (no `write()`) at TypeScript compile time only. ADR 35 D-8 specifies a runtime `SecurityException` if a tool somehow acquires write access. This runtime guard is not implemented. Add `SecurityException` class and runtime check in Phase 2.
