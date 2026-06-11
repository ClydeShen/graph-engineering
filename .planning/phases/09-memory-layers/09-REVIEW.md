---
phase: 09-memory-layers
reviewed: 2026-06-11T00:00:00Z
depth: standard
files_reviewed: 9
files_reviewed_list:
  - packages/control-plane/src/pulse-fetch.ts
  - packages/gateway/src/index.ts
  - packages/gateway/src/process-agent-turn.ts
  - packages/gateway/src/routes/events.ts
  - packages/workers/src/context/assemble.ts
  - packages/workers/src/index.ts
  - packages/workers/src/memory/gate3.integration.test.ts
  - packages/workers/src/memory/reflect.function.test.ts
  - packages/workers/src/memory/reflect.function.ts
findings:
  critical: 1
  warning: 3
  info: 3
  total: 7
status: issues_found
---

# Phase 09: Code Review Report

**Reviewed:** 2026-06-11T00:00:00Z
**Depth:** standard
**Files Reviewed:** 9
**Status:** issues_found

## Summary

This diff (a) removes the EpisodicMemoryWorker self-trigger from pulse-fetch and replaces it with TemplateProposalWorker (D-01), (b) wires `mem::reflect` (Reflection Track hybrid retrieval, ADR-21) as a new pure function with full unit-test coverage, and (c) wires "cold_start" reflection injection into both the Gateway's `processAgentTurn` and the Worker-side `runContextAssemblyPipeline`.

`reflect.function.ts` itself is well-structured, has solid unit tests for budget computation and section truncation, and the SQL hybrid-search queries (RRF formula) are consistent across the three tiers.

The most serious problem is in `process-agent-turn.ts`: the "cold_start" gate (`SELECT COUNT(*) FROM episodic_memory WHERE scope_id = $1`) cannot ever observe a non-zero count for an open scope, because `episodic_memory` is only populated by `TemplateProposalWorker.onScopeClosed` — i.e. after the scope closes. Combined with the `!scopeClosed` guard, this means the "cold_start-only" `memReflect` call (embedding + 3 hybrid SQL searches) fires on **every** agent turn for **every** scope, not just the first one. This contradicts the stated D-10 intent and the "cold_start" trigger-type semantics used to compute the budget.

There is also a duplication risk: the gateway's inline "has episodic memory" check and the Worker pipeline's injected `hasEpisodic` callback implement the same concept independently, with different semantics (`COUNT(*) = 0` vs an opaque callback whose implementation isn't present in this diff) — these can drift.

## Critical Issues

### CR-01: cold_start reflection fires on every turn, not just cold start (process-agent-turn.ts)

**File:** `packages/gateway/src/process-agent-turn.ts:78-93`
**Issue:**
The cold-start gate is:
```ts
if (context !== null && !scopeClosed) {
  const { rows: epiRows } = await pool.query<{ cnt: string }>(
    'SELECT COUNT(*)::text AS cnt FROM episodic_memory WHERE scope_id = $1',
    [scopeId],
  );
  if (epiRows[0].cnt === '0') {
    const reflection = await memReflect(pool, embeddingProvider, { ... trigger_type: 'cold_start', ... });
    ...
  }
}
```

`episodic_memory` rows for a scope are only written by `TemplateProposalWorker.onScopeClosed` (`packages/workers/src/memory/template-proposal.worker.ts`, called via `graph::scope::closed` subscriber registered in `packages/workers/src/index.ts`). `appendEpisodicTrace` (the per-event write path on `PoolMemoryRepository`) has **no production caller** — it is only exercised by the in-memory mock in tests.

Consequence: for any scope that is still open (`scopeClosed === false`, which is required to enter this branch), `COUNT(*) FROM episodic_memory WHERE scope_id = $1` is **always 0**. The branch is therefore taken on **every single turn** of every scope's lifetime (until the scope closes, at which point `!scopeClosed` becomes false and the branch is skipped entirely). The "cold_start" semantics — meant to fire once, at the start of a scope — never actually gate anything; this becomes an "every-turn" reflection injection.

This means every agent turn now incurs:
- 1 embedding API call (`embed.embed(query_text)`)
- 3 hybrid SQL searches (procedural / episodic / semantic, each with vector + BM25 CTEs over up to 20 candidates)

...for the entire lifetime of every scope, contrary to the documented "cold_start Reflection Track injection" (D-10) intent and the `computeReflectBudget('cold_start', ...)` semantics (which assume this only happens once per scope).

**Fix:**
Gate on something that actually distinguishes "first turn of the scope" — e.g. count of events in `execution_event_log` for the scope (excluding the just-written current event), or a dedicated "scope just created" flag/column, or track via `working_memory`/a per-scope marker row written on first turn. Example using the event log:

```ts
if (context !== null && !scopeClosed) {
  const { rows: countRows } = await pool.query<{ cnt: string }>(
    'SELECT COUNT(*)::text AS cnt FROM execution_event_log WHERE scope_id = $1',
    [scopeId],
  );
  // version_hash for the just-written event is already counted, so "1" means this is the first turn.
  if (countRows[0].cnt === '1') {
    const reflection = await memReflect(pool, embeddingProvider, { ... });
    context.reflectionContent = reflection.content;
    context.reflectionTokens = reflection.tokens;
  }
}
```

Whatever the chosen signal, it must converge to "false" after the first turn of a given scope — `episodic_memory` cannot serve that purpose under the current write topology.

## Warnings

### WR-01: Duplicated "is this cold start" logic across gateway and worker pipeline

**File:** `packages/gateway/src/process-agent-turn.ts:78-93`, `packages/workers/src/context/assemble.ts:314-327`
**Issue:**
Both `processAgentTurn` (gateway) and `runContextAssemblyPipeline` (workers) independently implement "check whether cold_start reflection should fire, and if so call `memReflect`/`opts.memReflect.fn` and merge `reflectionContent`/`reflectionTokens` into the result." The gateway's version inlines a `COUNT(*) FROM episodic_memory` query directly; the worker pipeline's version delegates to an injected `hasEpisodic(scopeId)` callback whose concrete implementation isn't present in this diff. These two "cold start" definitions can silently diverge — e.g. if the worker-side `hasEpisodic` implementation is fixed to use a correct signal but the gateway's inline query (CR-01) is left using the broken `episodic_memory` count, behavior between the two call sites will permanently differ.

**Fix:** Extract a single shared helper (e.g. `isScopeColdStart(pool, scopeId): Promise<boolean>`) in a shared module, and have both `processAgentTurn` and the `hasEpisodic` callback wired in `packages/workers/src/index.ts` call the same helper. This also fixes CR-01 in one place instead of two.

### WR-02: `formatProcedural` can cause the procedural section to exceed its own budget on the last item

**File:** `packages/workers/src/memory/reflect.function.ts:201-221`
**Issue:**
The loop only checks `remaining <= 0` *before* processing each row, not after pushing the chosen `entry`. For the truncated-entry branch (`fullTokens > budgetTokens * 0.6`), the truncated `entry` (header + intent line, no `template_graph`) is pushed unconditionally even if `entryTokens > remaining`, which can drive `remaining` negative and make `pTokens` (returned via `countTokens(procText)`) exceed `budget`. Downstream, `memReflect` clamps the episodic/semantic budgets via `Math.max(0, budget - pTokens)`, so the *overall* contract isn't violated catastrophically, but the procedural section itself can overshoot its allocated share of the budget — and if `pTokens > budget`, episodic and semantic sections are starved entirely even though the spec implies a "best effort" allocation across all three tiers, not "procedural may overrun the total budget."

**Fix:** After computing `entryTokens`, check `if (entryTokens > remaining && parts.length > 0) break;` before pushing, so the procedural section never exceeds `budgetTokens` once at least one entry has been included. (The existing test at `reflect.function.test.ts:51-88` only asserts episodic/semantic become empty — it does not assert `pTokens <= budget`, so this overrun is currently untested.)

### WR-03: `memReflect`'s `query_text` for `processAgentTurn` cold-start uses raw event payload, including for non-string payloads

**File:** `packages/gateway/src/process-agent-turn.ts:85`
**Issue:**
```ts
query_text: typeof event.payload === 'string' ? event.payload : JSON.stringify(event.payload),
```
For non-string payloads, the entire JSON-serialized payload (which could be large/arbitrary nested structure) is passed as `query_text` to `embed.embed()` and into the BM25 `plainto_tsquery('english', $2)` calls in all three hybrid-search queries. `plainto_tsquery` on a large JSON blob produces a query with potentially hundreds of terms, which is wasteful and may not reflect meaningful "intent" for retrieval — degrading the relevance of the RRF ranking for cold-start reflection. This is a quality concern compounded by CR-01 (this now runs on every turn, so the cost recurs every turn).

**Fix:** Once CR-01 is fixed (so this only fires once per scope), consider extracting a more targeted "intent" string (e.g. a specific field from the payload, or a short summary) rather than serializing the entire payload object for embedding/BM25 query purposes.

## Info

### IN-01: `epiRows[0]` accessed without guarding against an empty result set

**File:** `packages/gateway/src/process-agent-turn.ts:79-83`
**Issue:** `pool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM ... WHERE scope_id = $1', [scopeId])` is a `COUNT(*)` aggregate without `GROUP BY`, so it always returns exactly one row in practice — `epiRows[0]` is safe at runtime. However, the project's `tsconfig.json` does not set `noUncheckedIndexedAccess`, so this access is untyped as possibly-`undefined` and would throw a `TypeError: Cannot read properties of undefined` if the query implementation ever changed (e.g. to add a `GROUP BY` or `WHERE` that could short-circuit). Low risk given current SQL, but worth a defensive `?? '0'`.

**Fix:**
```ts
if ((epiRows[0]?.cnt ?? '0') === '0') {
```

### IN-02: `runContextAssemblyPipeline`'s `memReflect` injection point is unreachable from any current caller in this diff

**File:** `packages/workers/src/context/assemble.ts:270-278, 314-327`
**Issue:** `runContextAssemblyPipeline` now accepts an `opts.memReflect` object with `fn` and `hasEpisodic`, and `worker.shouldReflect()` (default `true` per `worker.abstract.ts:132`) gates whether the cold-start branch executes. However, no caller in the reviewed diff passes `opts.memReflect` — `packages/workers/src/index.ts` registers `mem::reflect` as a standalone function (`worker.registerFunction('mem::reflect', ...)`) but doesn't appear to wire it into any Worker's `runContextAssemblyPipeline` call via `opts.memReflect`. If this wiring is intended for a later phase, that's fine, but as it stands this is dead/unreachable code added without a caller — worth confirming it's intentionally deferred rather than an oversight (the gateway path in `process-agent-turn.ts` bypasses `runContextAssemblyPipeline` entirely and calls `assembleContext` + `memReflect` directly, so the two cold-start paths are not just duplicated (WR-01) but one of them currently has zero production callers).

**Fix:** Either wire `opts.memReflect` into the relevant Worker call site(s) in this phase, or note in `.harness/implementation-notes.md` that this is intentionally deferred to a later plan, to avoid the next reviewer flagging it as orphaned.

### IN-03: pulse-fetch.ts comment at line 84-86 is now stale relative to the removed code block

**File:** `packages/control-plane/src/pulse-fetch.ts:84-86`
**Issue:** The comment block:
```ts
// Note: replay does NOT re-trigger EpisodicMemoryWorker — events replayed at boot
// were already processed (or missed intentionally). Episodic writes are idempotent
// per content_hash but re-triggering on replay would create duplicate records.
```
refers to `EpisodicMemoryWorker`, which this diff's sibling change (in `packages/workers/src/index.ts`) removed entirely (replaced by `TemplateProposalWorker`, D-01). The corresponding "Also feed episodic memory..." trigger block that this comment was explaining was removed from the live-notification handler (lines that used to follow the `else` branch around line 148 in the old version), but this comment in the **replay loop** (a different code path) was left behind referencing a worker that no longer exists in the registration table.

**Fix:** Update or remove the stale comment to avoid confusing future readers about a worker (`EpisodicMemoryWorker`) that no longer exists:
```ts
// Note: replay does not re-trigger any per-event episodic write — episodic_memory
// is now populated only by TemplateProposalWorker.onScopeClosed (D-01), which is
// itself a durable subscriber on graph::scope::closed and replays independently.
```

---

_Reviewed: 2026-06-11T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
