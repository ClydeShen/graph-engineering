# Phase 9: memory-layers — Context

**Gathered:** 2026-06-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Activate the three dormant memory tiers by extending schemas, implementing write paths with embeddings, wiring the `mem::reflect` hybrid retrieval function (ADR-21), and connecting the Reflection Track to the Phase 08 pipeline hooks.

**Specific deliverables:**
1. `episodic_memory` schema extension: add `embedding vector(1536)` column + HNSW index + `intent_summary`/`outcome_summary` columns; new migration.
2. `TemplateProposalWorker` (replaces `EpisodicMemoryWorker`): fires on `scope_closed`, reads full Scope DAG via `TrailReader`, LLM-extracts `intent_summary` + `outcome_summary`, generates embedding inline, writes to `episodic_memory`.
3. `SemanticMemoryWorker` supersession: add `supersede()` op to `MemoryRepository` + similarity check hint at write time — `insertSemanticFact(scopeId, content, embedding)` returns `{ suggestedMerge: ExistingRecord | null }`. No auto-supersede; caller decides.
4. `procedural_memory` dual HNSW: add negative-sample partial HNSW index (`WHERE is_anti_pattern = TRUE`); `TemplateProposalWorker` detects orphan nodes (dead-end entity_ids after scope_closed) and writes negative samples.
5. `mem::reflect` function: implement ADR-21 spec (`packages/workers/src/memory/reflect.function.ts`), registered as iii Function. `cold_start` trigger wired via base `Worker.shouldReflect()` opt-out method overriding `onContextAssembled`.

**Out of scope:** LLM contradiction-driven supersession (Phase 10), `conflict_detected`/`macro_planning` triggers (Phase 10), Ebbinghaus reinforcement loop (Phase 10), Procedural skeleton extraction by TPW (Phase 10), Trail Discovery (Phase 10).

</domain>

<decisions>
## Implementation Decisions

### TemplateProposalWorker
- **D-01:** `TemplateProposalWorker` **replaces** `EpisodicMemoryWorker`. All episodic writes go through TPW on `scope_closed`. `EpisodicMemoryWorker` is deprecated and removed. Episodic memory is always an LLM-distilled scope summary, never raw content.
- **D-02:** TPW reads the **full Scope DAG** — all `execution_event_log` rows for `scope_id` via `TrailReader`. Matches ROADMAP spec "读取 Scope 完整 DAG". No last-N shortcut.
- **D-03:** Phase 09 TPW scope is **Episodic only**: intent_summary + outcome_summary + embedding written to `episodic_memory`. Procedural skeleton extraction (positive template graph) deferred to Phase 10 ("complete version").
- **D-04:** TPW calls `EmbeddingProvider.embed(intent_summary + outcome_summary)` **inline** before INSERT — atomic write. Every episodic row has an embedding; HNSW index is always populated.
- **D-05:** TPW also detects **orphan nodes** in the same `scope_closed` pass and writes them to `procedural_memory(is_anti_pattern=TRUE)`. Orphan = `entity_id` in the scope with no successor event (dead-end via LEFT JOIN on scope_id + entity_id). Keeps the scope_closed pass atomic — one Worker, two write paths.

### Semantic Memory Supersession
- **D-06:** `insertSemanticFact` signature changes to `insertSemanticFact(scopeId: string, content: string, embedding: number[])`. Caller pre-computes embedding (consistent with D-04 TPW pattern).
- **D-07:** `MemoryRepository` internally runs HNSW similarity query with the provided embedding. Returns `{ id: string, suggestedMerge: { id: string; content: string } | null }`. Threshold: cosine similarity > 0.89.
- **D-08:** **No auto-supersede** at write time. The caller (`SemanticMemoryWorker`) inspects `suggestedMerge` and explicitly calls `supersede(oldId, newId)` if merging. Matches ROADMAP "建议合并而非强制覆盖".
- **D-09:** LLM-based contradiction detection (design notes §3 second supersession trigger) **deferred to Phase 10**. Phase 09 has only the similarity-threshold path.

### Reflection Track (mem::reflect)
- **D-10:** Phase 09 wires **`cold_start` trigger only**. Detection: at `onContextAssembled`, if no episodic records exist for the current `scopeId`, trigger `mem::reflect` with `trigger_type='cold_start'`. `conflict_detected` and `macro_planning` triggers deferred to Phase 10.
- **D-11:** Base `Worker` abstract class gets a `shouldReflect(): boolean` method defaulting to `true`. Workers override to `false` to opt out. This is the **opt-out** pattern — memory augmentation is on by default for all Workers.
- **D-12:** `mem::reflect` lives in `packages/workers/src/memory/reflect.function.ts` and is registered as an iii Function in `packages/workers/src/index.ts`. No new package dependency needed — `MemoryRepository` seam is available in the workers package.

### Procedural Memory Negative Samples
- **D-13:** New migration adds `idx_procedural_memory_topology_hnsw_negative` partial HNSW index `WHERE is_anti_pattern = TRUE`. Completes the dual HNSW structure. Phase 10 queries this index for anti-pattern injection.

### Claude's Discretion
- Exact LLM prompt for `intent_summary`/`outcome_summary` extraction in TPW — keep it concise and consistent with how `SemanticMemoryWorker`'s chat prompt is worded.
- Whether `supersede()` uses a DB-level trigger or application-level UPDATE for `superseded_by` + `valid_until` — the trigger in migration 008 already handles `valid_until`, so application code just writes `superseded_by`.
- `TemplateProposalWorker` trigger config topic — use `graph::scope::closed` (matches `SEMANTIC_TRIGGER_CONFIG`'s existing topic).
- Migration number: next available after 011 is 012.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Memory Architecture ADRs
- `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` — BM25+HNSW RRF spec (K=60, weights 0.6/0.4), three-table query templates, `ts_doc` GIN schema. `mem::reflect` bottom-layer query SQL.
- `docs/adr/0022-adr21-reflection-track-trigger-spec.md` — `mem::reflect` full spec: interface, `PipelineContext` injection structure, sequential greedy truncation, trigger-type budgets, ADR-21 pseudocode. **Primary reference for reflect.function.ts.**

### Existing Implementation (Phase 03–08 stubs — READ FIRST)
- `packages/workers/src/memory/episodic.worker.ts` — `EpisodicMemoryWorker` (to be replaced by TPW)
- `packages/workers/src/memory/semantic.worker.ts` — `SemanticMemoryWorker.onScopeClosed()` — update signature + add supersession hint handling
- `packages/workers/src/memory/procedural.worker.ts` — `ProceduralMemoryWorker` — review for orphan node write path
- `packages/workers/src/base/memory-repository.ts` — `MemoryRepository` interface + `PoolMemoryRepository` — extend with `supersede()` + updated `insertSemanticFact` signature
- `packages/workers/src/base/worker.abstract.ts` — `Worker` abstract class + Phase 08 hooks (`onContextAssembled`, `PipelineContext`) — add `shouldReflect()` here
- `packages/workers/src/base/trail-reader.ts` — `TrailReader` — TPW uses this to read full Scope DAG

### Migrations (read all — understand existing schema before adding)
- `migrations/003-memory-tables.sql` — Phase 1 table creation (episodic/semantic/procedural/working)
- `migrations/006-memory-extensions.sql` — Phase 2 extensions: entity_id, intent_summary, outcome_summary on episodic; superseded_by on semantic; reinforcement columns on procedural
- `migrations/008-semantic-memory-validity.sql` — `valid_from`/`valid_until` + trigger on semantic_memory
- New migration (012): add `embedding vector(1536)` + HNSW index to `episodic_memory`; add negative-sample HNSW index to `procedural_memory`

### Phase 08 Context (pipeline hooks)
- `.planning/phases/08-context-assembly/08-CONTEXT.md` — D-06 through D-08: pipeline hook spec (`onContextAssembled`, `PipelineContext` shape). Phase 09 overrides these.

### Design Notes (pre-planning analysis)
- `.planning/phases/09-memory-layers/09-DESIGN-NOTES.md` — nanobot/hermes-agent comparison, "no MemoryProvider abstraction" decision, event-driven invariant, holographic `probe`/`related`/`reason` naming reference for future query API.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TrailReader` (`packages/workers/src/base/trail-reader.ts`): already used by `SubScopeResultWorker` and others to read scope events. TPW uses this to load full DAG.
- `EmbeddingProvider` interface + `OpenAICompatibleProvider.embed()` (`packages/shared/src/llm/`): already implemented, returns `{ vector: number[], countedAgainstBudget: false }`. TPW and SemanticMemoryWorker call this for embedding generation.
- `PoolMemoryRepository.insertProceduralTemplate(params)` (`memory-repository.ts`): already takes `embeddingLiteral` and `intentEmbeddingLiteral` — the orphan-node negative write reuses this signature with `is_anti_pattern: true`.
- Phase 08 `PipelineContext` includes `scopeId`, `wMax`, `ccrHashes[]`, `droppedCount` — `mem::reflect` reads `scopeId` and `wMax` from this.
- `SEMANTIC_TRIGGER_CONFIG` in `semantic.worker.ts`: listens on `graph::scope::closed` — TPW should use the same topic.

### Established Patterns
- Every memory write must trace to `execution_event_log` (Phase 1 constraint C1): TPW writes `memory_updated` event after episodic INSERT — same pattern as existing workers.
- `LLM CALL — ADR 22` comment convention: add to TPW's LLM call for the intent/outcome extraction.
- Trigger config exports as `const` named `{NAME}_TRIGGER_CONFIG` — TPW exports `TEMPLATE_PROPOSAL_TRIGGER_CONFIG`.
- `writeGuard()` wraps all content before LLM or DB writes (injection guard).

### Integration Points
- `Worker.onContextAssembled()` override → calls `this.iii.trigger('mem::reflect', ...)` when `shouldReflect()` && cold_start detected
- `SemanticMemoryWorker.onScopeClosed()`: after LLM distillation call, pass embedding to updated `insertSemanticFact()`, inspect `suggestedMerge`, call `supersede()` if merging
- New migration 012 must run before any TPW or mem::reflect query touches `episodic_memory.embedding`

</code_context>

<specifics>
## Specific Ideas

- `mem::reflect`'s query action naming: design notes §2 references holographic provider's `probe` / `related` / `reason` / `contradict` semantics. For Phase 09, the interface is the ADR-21 `trigger_type` enum — but internal method names inside `reflect.function.ts` can borrow these names (e.g., `searchEpisodic`, `searchSemantic`, `searchProcedural` mirroring the sequential greedy truncation steps).
- `ts_doc` GIN index uses `'english'` stemming (migration 003 accepted tradeoff). All BM25 queries use `plainto_tsquery('english', ...)` to match. Do NOT use `'simple'` in new migration columns — would require DROP+ADD on GENERATED columns.
- The `supersede()` operation only needs to write `superseded_by = newId` on the old row; migration 008's trigger fires automatically to stamp `valid_until`.
- ADR-21 pseudocode shows `iii.registerFunction('mem::reflect', async (input) => { ... })` — mirror this pattern exactly in `reflect.function.ts`.

</specifics>

<deferred>
## Deferred Ideas

- **LLM contradiction-driven supersession** (design notes §3): second supersession trigger path — LLM or embedding-distance contradiction detection. Phase 10.
- **`conflict_detected` + `macro_planning` Reflection Track triggers** (ADR-21): wiring beyond cold_start. Phase 10.
- **TPW Procedural skeleton extraction (positive samples)**: TemplateProposalWorker Phase 10 "complete version" extracts abstract topology templates and writes to `procedural_memory(is_anti_pattern=FALSE)` with full `template_graph` JSON. Phase 09 TPW writes only orphan-node negative samples.
- **CCR persistent store** (Phase 08 deferred): cross-invocation CCR retrieval if needed by Reflection Track. Phase 09 if Reflection Track needs it; otherwise Phase 10.
- **`probe`/`related`/`reason`/`contradict` named query actions** (holographic pattern from design notes §2): once Phase 09 `mem::reflect` is stable, Phase 10+ can expose these as named LLM tool actions on top of the retrieval function.

</deferred>

---

*Phase: 9-memory-layers*
*Context gathered: 2026-06-11*
