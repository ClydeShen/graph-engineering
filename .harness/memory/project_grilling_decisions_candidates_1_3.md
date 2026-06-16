---
name: project-grilling-decisions-candidates-1-3
description: Grilling loop decisions for Candidates 1+3 (processAgentTurn + makeKnapsackGraph + knapsackSlice). 5 design questions resolved 2026-06-10.
metadata: 
  node_type: memory
  type: project
  originSessionId: 90d3e1f6-9a76-4f7d-a817-eb8a348a8f4a
---

Grilling completed 2026-06-10. All 5 design questions resolved.

**Decisions:**

1. **knapsackSlice return type** → `{ kept: EventLogNode[], dropped: EventLogNode[] }` (was `EventLogNode[]`)
   - Caller (assembleContext) needs to know what was dropped for future CCR work

2. **makeKnapsackGraph strategy** → Two functions: `makeKnapsackGraph` (direct query on `execution_event_log`) + `makeKnapsackGraphFromView` (uses `scope_lineage_view` for O(1) on large scopes)
   - Matches existing call-site split: events.ts (write path, no view) vs scope-read.ts (GET path, view first)

3. **assembleContext treatment of dropped** → Ignore for now (Phase 08 concern)
   - CCR marker injection deferred; Phase 08 ADR supplement will cover it
   - assembleContext currently returns `{ stable, context, volatile }` — no `dropped` field yet

4. **processAgentTurn boundary** → Includes context assembly (`assembleContext` call inside)
   - Function signature: `processAgentTurn(pool, payload, wMax)` → `{ assembledContext, scopeClosed }`
   - events.ts becomes ~25 lines: parse → call processAgentTurn → format response

5. **Algorithm extensibility** → `KnapsackConfig` interface with `strategy` field (currently only `'newest-first'`)
   - Do NOT hardcode; KnapsackConfig is optional param to knapsackSlice
   - Phase 08 can add `'smart-crusher'` strategy without changing caller sites
   - User: "这部分不要写死代码。未来可能会改的。"

**Headroom learning integrated:**
- SmartCrusher: first_fraction=0.3 + last_fraction=0.15 + change points (Phase 08 algorithm signal)
- CCR: dropped events → `<<ccr:HASH>>` marker + tool injection (Phase 08 CCR signal)
- Transform protocol: `apply(messages, tokenizer) → TransformResult` (Phase 08 architecture signal)

**Files to implement:**
- `packages/gateway/src/process-agent-turn.ts` (new)
- `packages/gateway/src/knapsack-graph.ts` (new — two factory functions)
- `packages/workers/src/context/knapsack.ts` (modify — return type + KnapsackConfig)
- `packages/gateway/src/routes/events.ts` (reduce 163→~25 lines)

**Why:** Candidates 1+3 compose — makeKnapsackGraph is prerequisite for processAgentTurn. Together they make the hottest write path testable without Hono.

**How to apply:** Next step is `/gsd-plan-phase --skip-research` for Phase 8 (context-assembly). Need to determine correct phase number from `.planning/ROADMAP.md` first — phases 1-5 are complete in `.planning/`.

[[project_arch_review_candidates]]
[[reference_headroom_learning_directions]]
