# ADR 36: Knowledge Entity Write Timing

**Status:** Accepted  
**Date:** 2026-06-01  
**Supplements:** ADR 12 (Canonical Cognitive Event Enumeration), ADR 29 (Worker / Tool / Knowledge Boundaries)

## Context

Workers execute tools during their `onRunning()` phase and produce tool results that represent state changes, observations, or facts. ADR 12 mandates `memory_updated` as the event type for writing facts to the graph, but does not specify *when* within a Worker's execution these writes must occur — specifically, whether writes should happen after each tool result, after all tools in a turn, or only at session end. Without a formal timing decision, Workers may adopt different write strategies, creating potential history gaps on crash and undermining the Execution Graph as the append-only SSOT. This ADR locks the write timing before Phase 1 implementation.

## Decision

Every tool result that represents a state change or observable action is written to the Execution Graph immediately and atomically upon tool return (per-tool-result write). Lazy or deferred writes (per-session or per-turn) are permanently rejected for state-changing tool results. Pure read-only observations with no downstream dependencies may be omitted at Worker author discretion.

## Mechanism

### Per-Tool-Result Write Pattern

After each tool returns within a Worker's `onRunning()`:

```typescript
// Inside Worker.onRunning():
async onRunning(ctx: WorkerExecutionContext): Promise<WorkerResult> {
  // Tool execution 1
  const searchResult = await ctx.graph.query(/* ... */);
  const tool1Result = await searchTool.execute({ query: searchResult }, toolCtx);

  // Immediate atomic graph write — per-tool-result
  await ctx.graph.write({
    event_type: 'memory_updated',
    entity_id: tool1Result.entityId,
    payload: {
      entity_type: 'knowledge',
      knowledge_type: 'domain_fact',
      content: tool1Result.data,
      source_tool: 'search',
      status: 'active',
    },
    predecessor_hash: ctx.currentVersionHash,
  });
  // Update ctx.currentVersionHash to the new version hash from the write result
  ctx = ctx.advanceVersionHash(writeResult.version_hash);

  // Tool execution 2 (can depend on tool 1's result being in the graph)
  const tool2Result = await processTool.execute({ input: tool1Result.data }, toolCtx);

  // Immediate atomic graph write — per-tool-result
  await ctx.graph.write({
    event_type: 'memory_updated',
    entity_id: tool2Result.entityId,
    payload: { /* ... */ },
    predecessor_hash: ctx.currentVersionHash,
  });

  return WorkerResult.completed();
}
```

Combined with ADR 32's `ON CONFLICT DO NOTHING` idempotency constraint, each write is idempotent against iii's at-least-once redelivery. If the Worker crashes between tool 1's write and tool 2's write, iii redelivers the event; the Worker replays, tool 1's write is a silent no-op (`ON CONFLICT DO NOTHING`), and tool 2's write proceeds normally.

### Crash Safety Guarantee

```
Tool 1 executes → Write to graph → Tool 2 executes → Write to graph → ... → Worker.onRunning() returns

Worker crash at any point:
  All writes completed before the crash → permanently in graph (append-only)
  Write in progress at crash → PostgreSQL transaction rollback (atomic)
  No writes after crash → those tool results are re-executed after iii redelivery
```

The graph always contains all tool results up to the crash point, with no history gap. The SSOT invariant is preserved through crash and recovery.

### Observational Data Exception

Pure read-only observations with no side effects and no downstream tool dependencies MAY be omitted from per-result writes at the Worker author's discretion:

```typescript
// ALLOWED to omit: pure read with no downstream dependency
const fileList = await listFilesTool.execute({ path: '/tmp' }, toolCtx);
// No graph.write() — file listing has no side effects and nothing depends on it

// REQUIRED: state change
const writeResult = await writeFileTool.execute({ path: '/tmp/out.json', content }, toolCtx);
await ctx.graph.write({ /* ... */ }); // MANDATORY — file write is a state change

// REQUIRED: downstream dependency
const searchResult = await searchTool.execute({ query }, toolCtx);
await ctx.graph.write({ /* ... */ }); // MANDATORY — tool 2 will use this result
const processResult = await processTool.execute({ input: searchResult.data }, toolCtx);
```

**Classification rule:**
- State-changing tool result (any write to external system, file, database, API) → **MANDATORY write**
- Tool result used as input to another tool → **MANDATORY write** (preserves multi-tool dependency chain traceability)
- Pure read-only observation with no downstream tool depending on it → **MAY omit**

### Rejected Approaches

**Option C — Per-session lazy write (permanently abolished):**

Writing all tool results at session end (Worker.onCompleted()) creates a structural history gap: if a Worker executes 10 tools and crashes after tool 7, all 10 results are lost from the causal record. This is incompatible with the Execution Graph as SSOT. A crash cannot silently erase execution history.

**Option B — Per-turn batch write (permanently abolished):**

Batching all tool results within one LLM turn and writing at turn end loses within-turn tool ordering for multi-tool dependency chains. If tool N's output is tool N+1's input, the batch write cannot distinguish their causal ordering within the turn. Multi-tool dependency traceability is broken.

| Approach | History gap on crash | Multi-tool ordering | Decision |
|----------|---------------------|---------------------|----------|
| Per-tool-result (this ADR) | None | Preserved | **Accepted** |
| Per-turn batch (Option B) | Possible (within turn) | Lost | Rejected |
| Per-session lazy (Option C) | Severe (entire session) | Lost | Permanently abolished |

### Interaction with ADR 27 Processing Phase Restriction

ADR 27 mandates that the Processing phase (LLM reasoning) must not persist memory. The per-tool-result write occurs in the Writing phase transition that follows each individual tool execution — not in the Processing phase's LLM reasoning step. The Worker alternates between Processing (LLM call) and Writing (graph write) on each tool result, rather than batching all Processing before any Writing.

## Consequences

### Positive
- No history gap exists after any crash — the graph always reflects the true execution state up to the most recent completed tool result.
- Multi-tool dependency chains are fully traceable: each tool's input and output are separate graph nodes with a causal edge between them.
- Combined with ADR 32 idempotency, the write pattern is crash-safe and redelivery-safe.
- `scope_closed` can be triggered correctly by the ADR 19 watchdog — it counts completed tasks by inspecting `memory_updated` events, which are now guaranteed to exist for each tool result.

### Negative / Trade-offs
- Each tool result triggers a PostgreSQL write. For Workers that call many lightweight tools (e.g., a file-lister calling `list_files` 20 times), the write overhead may be non-trivial if the Observational Data Exception is not applied.
- The `currentVersionHash` must be threaded through the `onRunning()` execution and updated after each write, adding bookkeeping complexity to Worker implementations.
- Workers must correctly classify tool results as state-changing vs. read-only. Misclassification (omitting a mandatory write) is a logic error that silently creates a history gap — it is not detected by the type system.

## References
- ADR 02 — Version Hash computation (each per-tool-result write produces a new Version Hash)
- ADR 12 — Canonical cognitive events (`memory_updated` is the event type for Knowledge writes)
- ADR 27 — Worker lifecycle (Processing vs. Writing phase boundary; per-tool-result write straddles both)
- ADR 29 — Knowledge entity subtypes (domain_fact, skill, schema, plugin_doc)
- ADR 32 — PgQueueAdapter idempotency (`ON CONFLICT DO NOTHING` makes per-tool-result writes crash-safe)
- ADR 35 — Worker/Tool boundary (`ctx.graph.write()` is only available to Workers, not Tools)
