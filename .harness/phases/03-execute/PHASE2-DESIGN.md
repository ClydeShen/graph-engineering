# Phase 2: Memory & Retrieval — Design Specification

> **Status:** Ready for planning  
> **Dependencies:** Phase 1 complete (Gate 1 E2E passed, Gate 2 endpoints delivered)  
> **Schema:** `migrations/003-memory-tables.sql` already exists — workers read/write these tables  
> **Gate 2 AC already delivered:** `/sys/health` ✓ `/scopes/:id/topology` ✓ P0-E fix ✓ write_guard ✓

---

## Scope

Phase 2 activates the three-layer memory system defined in ADR 20 and the hybrid BM25+HNSW retrieval pipeline defined in ADR 20 §Hybrid Retrieval. Phase 1 created the tables and HNSW index; Phase 2 writes to them and reads from them.

---

## Memory Architecture (ADR 20)

### Three tiers

| Tier | Table | TTL | Purpose |
|------|-------|-----|---------|
| Episodic | `episodic_memory` | Short (session-scoped) | Per-scope event traces, raw tool outputs |
| Semantic | `semantic_memory` | Medium (cross-scope) | Synthesized facts, distilled knowledge |
| Procedural | `procedural_memory` | Long (permanent) | Reusable workflow templates, reinforcement-scored |

### Working memory

`working_memory` table — intra-scope scratchpad with 5-minute SHA-256 dedup window (ADR 11 supplement, Task 5).

---

## Workers to implement

### 1. EpisodicMemoryWorker
- **Trigger:** `task_spawned` + `memory_updated` events via iii-sdk topic subscription
- **Write:** INSERT into `episodic_memory` with `scope_id`, `entity_id`, `content`, `ts_doc`
- **Gate:** writeGuard runs on content before INSERT
- **Phase 1 constraint:** C1 — all writes also append a `memory_updated` event to `execution_event_log`

### 2. SemanticMemoryWorker  
- **Trigger:** `scope_closed` event (synth window opens)
- **Write:** INSERT/UPDATE `semantic_memory` via `occWriteIdempotent`
- **Retrieval:** BM25 via `ts_doc @@ to_tsquery(...)` with GIN index (already created)
- **Phase 1 constraint:** C3 — predecessor_hash chain correct

### 3. ProceduralMemoryWorker
- **Trigger:** Memory Synthesizer output (daily 2AM + scope_closed ≥20 episodic records)
- **Write:** INSERT into `procedural_memory` with `template_graph JSONB`, `success_count`, `topology_embedding vector(128)`
- **Reinforcement SQL:** `UPDATE procedural_memory SET success_count = success_count + 1, last_used_at = NOW() WHERE id = $matched_template_id` (ADR 20 Task 1)

### 4. MemorySynthesizerWorker
- **Trigger:** iii-cron `'0 0 2 * * * *'` (daily 2AM) + optional scope_closed event when episodic_count ≥ 20 (ADR 20 Task 2)
- **Action:** Distill episodic → semantic, propose procedural templates
- **Ebbinghaus decay scan:** `'0 0 3 * * * *'` (daily 3AM), logical delete via `superseded_by = id` where `reinforcement_count = 0 AND last_used_at < NOW() - INTERVAL '90 days'` (Task 3)

---

## Hybrid Retrieval (ADR 20 §Hybrid Retrieval / ADR 21)

```
BM25 rank  (ts_doc @@ query, GIN index)     weight α
+
HNSW rank  (topology_embedding <=> $vec)    weight β
→ RRF fusion  score = 1/(k + rank_bm25) + 1/(k + rank_hnsw)
→ Top-K results returned to Knapsack assembly
```

- BM25 already enabled: `ts_doc` GIN index in `003-memory-tables.sql`
- HNSW already enabled: `topology_embedding vector(128)` index in `003-memory-tables.sql`
- RRF k constant: 60 (standard default per ADR 21)
- Returns results as `EventLogNode[]` for Knapsack consumer

---

## New Gateway routes (Phase 2)

| Route | Purpose |
|-------|---------|
| `GET /v1/memory/search?q=...&scope_id=...` | Hybrid BM25+HNSW retrieval entry point |
| `POST /v1/memory/reinforce` | Increment `procedural_memory.success_count` |

---

## Constraints carried from Gate 2 (all satisfied)

- C1: New `event_type`s (`memory_updated` already canonical) → `execution_event_log` ✓  
- C2: Gate 1 endpoints unaffected ✓  
- C3: predecessor_hash chain unbroken — Workers use `occWriteIdempotent` ✓  

---

## Working Memory dedup (ADR 11 supplement — Task 5)

Dedup hash: `SHA256(scope_id|entity_id|event_type|payload_hash)` with 5-minute `created_at` window.  
Applied at `working_memory` INSERT layer. Does not affect `execution_event_log` structural dedup.

---

## Phase 2 Gate (Gate 3)

| # | Acceptance Criterion |
|---|---------------------|
| G3-1 | `episodic_memory` receives rows after agent task completion |
| G3-2 | `semantic_memory` receives synthesis rows after `scope_closed` |
| G3-3 | `procedural_memory` receives template rows after Memory Synthesizer run |
| G3-4 | `GET /v1/memory/search?q=hello` returns ranked results from BM25+HNSW RRF |
| G3-5 | Duplicate tool call within 5 min → only 1 row in `working_memory` |
| G3-6 | Ebbinghaus decay: records older than 90 days with `reinforcement_count=0` get `superseded_by = id` |
| G3-7 | All Gate 2 endpoints still pass (regression) |

---

## Open questions (for planning phase)

1. **Embedding model**: What model generates `topology_embedding vector(128)`? Needs to be the same model at write and query time. ADR 25 supplement (Task 8) defines training strategy — Phase 2 can use a deterministic placeholder or real model.
2. **Working memory retention**: When does `working_memory` expire? ADR does not specify TTL — default to 24h or scope-close trigger?
3. **Memory Synthesizer LLM**: Phase 2 needs an LLM call for distillation. `OpenAICompatibleProvider` is already in `@graph/shared`. Wire in workers/index.ts when implementing `MemorySynthesizerWorker`.

---

_Created: 2026-06-03 | Source: ADR 20, ADR 21, 02-PLAN.md Tasks 1–5, Gate 2 retrospective_
