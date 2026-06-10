# Phase 9: memory-layers — Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-11
**Phase:** 09-memory-layers
**Areas discussed:** TemplateProposalWorker scope, Semantic supersession scope, Reflection Track wiring, Procedural Memory negative samples

---

## TemplateProposalWorker scope

| Option | Description | Selected |
|--------|-------------|----------|
| Replace EpisodicMemoryWorker | Deprecate raw-content worker; all episodic writes go through TPW on scope_closed. | ✓ |
| Coexist — different triggers | Keep EpisodicMemoryWorker for raw per-event writes; TPW adds scope-level summaries. | |
| Coexist — rename EpisodicMemoryWorker | Keep raw write path, rename to TraceIngestWorker; TPW is the "useful" episodic entry. | |

**User's choice:** Replace EpisodicMemoryWorker

| Option | Description | Selected |
|--------|-------------|----------|
| Full Scope DAG | Read all execution_event_log rows for scope_id via TrailReader. | ✓ |
| Last N events (e.g. 50) | Like SemanticMemoryWorker today; simpler but diverges from ROADMAP spec. | |
| CrystallizeWorker output only | Consume already-crystallized Lesson; avoids duplicate LLM call. | |

**User's choice:** Full Scope DAG

| Option | Description | Selected |
|--------|-------------|----------|
| Episodic only in Phase 09 | TPW extracts intent_summary + outcome_summary + embedding. Procedural skeleton deferred to Phase 10. | ✓ |
| Episodic + Procedural skeleton in Phase 09 | TPW does both summary extraction AND template_graph skeleton. Heavier Phase 09. | |

**User's choice:** Episodic only in Phase 09

| Option | Description | Selected |
|--------|-------------|----------|
| Inline at write time | EmbeddingProvider.embed() called before INSERT; every row has embedding. | ✓ |
| Nullable, populated later | INSERT NULL first, background job populates. Simpler write but HNSW misses unpopulated rows. | |

**User's choice:** Inline at write time

---

## Semantic supersession scope

| Option | Description | Selected |
|--------|-------------|----------|
| supersede() op + similarity check | Automatic >0.89 threshold hint. LLM contradiction detection deferred to Phase 10. | ✓ |
| Full Phase 09: supersede() + similarity + contradiction | All detection logic including LLM-based contradiction. Complete but heavier. | |
| Just supersede() op, no auto-detection | Only the operation; detection is caller's responsibility (Phase 10). | |

**User's choice:** supersede() op + similarity check

| Option | Description | Selected |
|--------|-------------|----------|
| Return hint to caller, no auto-supersede | insertSemanticFact returns { suggestedMerge }; caller decides. Matches ROADMAP "建议合并而非强制覆盖". | ✓ |
| Auto-supersede immediately | If >0.89, auto-call supersede(). Simpler call site but destroys facts silently. | |

**User's choice:** Return hint to caller, no auto-supersede

| Option | Description | Selected |
|--------|-------------|----------|
| MemoryRepository handles internally | Caller passes embedding; repo runs HNSW query and returns hint. Clean seam. | ✓ |
| SemanticMemoryWorker queries separately | Worker calls hybridSearch(), inspects, then calls supersede(). Duplicates retrieval logic. | |

**User's choice:** MemoryRepository handles internally

---

## Reflection Track wiring

| Option | Description | Selected |
|--------|-------------|----------|
| cold_start only | If no episodic records for scope, trigger mem::reflect cold_start. Others deferred to Phase 10. | ✓ |
| cold_start + conflict_detected | Also detect conflicts via PipelineContext.droppedCount or prior conflict events. | |
| All three trigger types | Include macro_planning detection in Phase 09. Highest complexity. | |

**User's choice:** cold_start only

| Option | Description | Selected |
|--------|-------------|----------|
| Base Worker opt-out | shouldReflect() defaults true; Workers override to disable. Memory-augmented by default. | ✓ |
| Opt-in per Worker subclass | Only Workers that explicitly override onContextAssembled call mem::reflect. Risk of silent omission. | |

**User's choice:** Base Worker opt-out

| Option | Description | Selected |
|--------|-------------|----------|
| packages/workers/src/memory/reflect.function.ts | Alongside other memory workers; no new dependency. Registered in workers index. | ✓ |
| packages/control-plane/src/reflect.ts | Would require new workers→control-plane cross-package dependency. | |

**User's choice:** packages/workers/src/memory/reflect.function.ts

---

## Procedural Memory negative samples

| Option | Description | Selected |
|--------|-------------|----------|
| Nodes with no successor after scope_closed | entity_id with no later event in scope (dead-end). Detectable via LEFT JOIN. | ✓ |
| Events with conflict_detected in successor chain | More semantically precise but requires graph traversal. | |
| Events with status=cancelled or unresolved | Requires consistent status column population. | |

**User's choice:** Nodes with no successor after scope_closed

| Option | Description | Selected |
|--------|-------------|----------|
| TemplateProposalWorker writes both | TPW on scope_closed detects orphans in same pass; writes to procedural is_anti_pattern=TRUE. | ✓ |
| Separate ProceduralNegativeWorker | Dedicated worker on scope_closed for orphan detection. More separation, same trigger. | |

**User's choice:** TemplateProposalWorker writes both

| Option | Description | Selected |
|--------|-------------|----------|
| Add negative HNSW index in Phase 09 | idx_procedural_memory_topology_hnsw_negative (WHERE is_anti_pattern = TRUE). Complete dual HNSW. | ✓ |
| Defer to Phase 10 | Write rows now, add index when Phase 10 queries them. Leaves table half-built. | |

**User's choice:** Add negative HNSW index in Phase 09

---

## Claude's Discretion

- Exact LLM prompt wording for intent_summary/outcome_summary extraction in TemplateProposalWorker
- Whether supersede() uses application-level UPDATE vs relying solely on migration 008 trigger for valid_until (note: trigger already handles valid_until automatically)
- TemplateProposalWorker trigger config topic (recommend reusing `graph::scope::closed`)
- Migration number (012 is next available)
- mem::reflect internal method names for the three retrieval steps

## Deferred Ideas

- LLM contradiction-driven supersession (design notes §3) — Phase 10
- conflict_detected and macro_planning Reflection Track triggers — Phase 10
- TemplateProposalWorker Procedural skeleton extraction (positive template_graph) — Phase 10 "complete version"
- CCR persistent store if Reflection Track needs cross-invocation retrieval — Phase 10
- probe/related/reason/contradict named LLM query actions (holographic pattern) — Phase 10+
