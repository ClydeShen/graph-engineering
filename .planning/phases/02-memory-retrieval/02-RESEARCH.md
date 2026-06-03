# Phase 2: Memory & Retrieval — Research

**Researched:** 2026-06-04
**Domain:** PostgreSQL BM25+HNSW hybrid retrieval, iii-sdk cron/event worker patterns, LLM provider wiring, Ebbinghaus decay
**Confidence:** HIGH — all core findings verified directly from codebase (canonical source), existing ADR supplements, and Phase 1 worker patterns

---

## Summary

Phase 2 activates the three-layer memory system whose schema already exists in `migrations/003-memory-tables.sql`. The GIN indexes for BM25 (`ts_doc`) and the HNSW index for `topology_embedding vector(128)` are live — Phase 2 only writes data and queries it. The RRF formula, SQL templates, token budget enforcement, and trigger specifications are fully locked in ADR 20 supplement and ADR 21 (files `docs/adr/0021-*` and `docs/adr/0022-*`).

The iii-sdk registration pattern is validated from Phase 1: `registerWorker` → `registerFunction` + `registerTrigger`. Cron workers use `{ type: 'cron', config: { expression: '...' } }` and do not hold a `GraphHandle` (they use a raw `Pool`, matching the `PatternDiscoveryWorker` pattern). Event-triggered workers subscribe via `{ type: 'durable:subscriber', config: { topic: '...' } }`. All four new workers follow one of these two patterns.

The write path is resolved: `occWrite` for first-write OCC writes (memory_updated event to execution_event_log only); direct `pool.query` INSERT for memory table rows (episodic/semantic/procedural/working_memory are NOT append-only event log partitions — they are ordinary INSERT tables outside the OCC chain). The `writeGuard` function is already implemented in `@graph/shared` and receives a string payload, applies regex redaction, and returns the scrubbed string.

**Primary recommendation:** Build four workers in `packages/workers/src/memory/` following the `PatternDiscoveryWorker` (cron) and `FrontierSchedulerWorker` (event-triggered) patterns. Register all four in `packages/workers/src/index.ts`. The hybrid retrieval SQL templates are in ADR 20 supplement — copy them verbatim with `plainto_tsquery('simple', $query_text)` for BM25 and `embedding <=> $vec` for HNSW.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| episodic_memory writes | Worker (`EpisodicMemoryWorker`) | — | Triggered by task_spawned/memory_updated events via iii durable:subscriber |
| semantic_memory synthesis | Worker (`SemanticMemoryWorker`) | — | Triggered by scope_closed; distillation from episodic records |
| procedural_memory templates | Worker (`ProceduralMemoryWorker`) | — | Triggered by MemorySynthesizer output; WL topology embedding computation |
| Memory decay / synthesis orchestration | Worker (`MemorySynthesizerWorker`) | — | iii-cron 2AM daily + scope_closed threshold trigger |
| Hybrid BM25+HNSW retrieval | Database (PostgreSQL) | Gateway route | SQL CTE template executes entirely in DB; Gateway surfaces it as REST |
| mem::reflect token budget enforcement | iii-engine (registerFunction) | Worker (caller) | ADR 21: centralised in iii-engine layer, not per-Worker |
| working_memory dedup | Worker (EpisodicMemoryWorker) | Database (SHA-256 constraint) | Application-layer hash check before INSERT; 5-min window |
| Gateway memory routes | HTTP Gateway (Hono) | — | GET /v1/memory/search, POST /v1/memory/reinforce |
| ConflictResolverWorker LLM merge | Worker | LLM Provider | Phase 2 adds LLM semantic merge to existing Phase 1 stub |
| LLM call (distillation, embedding) | `OpenAICompatibleProvider` in @graph/shared | — | ADR 22: all calls via injected provider, never raw HTTP in Workers |

---

## Standard Stack

### Core (already in project — no new installs)

| Library | Version | Purpose | Source |
|---------|---------|---------|--------|
| `iii-sdk` | 0.16.x | Worker registration, cron triggers, durable:subscriber | [VERIFIED: Phase 1 usage, iii-engine.md] |
| `pg` (node-postgres) | — | Pool for all DB queries in workers | [VERIFIED: Phase 1 usage] |
| `@graph/shared` | workspace | occWrite, occWriteIdempotent, writeGuard, LLMProvider/EmbeddingProvider, canonicalJson | [VERIFIED: src/index.ts exports confirmed] |
| PostgreSQL 15+ pgvector | — | HNSW `<=>` operator, tsvector BM25 | [VERIFIED: migrations/003-memory-tables.sql] |
| Hono | — | New gateway routes (GET /v1/memory/search, POST /v1/memory/reinforce) | [VERIFIED: gateway/src/index.ts pattern] |

### No New Package Installs Required

Phase 2 requires zero new npm packages. All dependencies (`pg`, `iii-sdk`, Hono, `@graph/shared`) are already present. The `OpenAICompatibleProvider` in `@graph/shared/src/llm/openai-compatible.provider.ts` is already exported via `@graph/shared` index.ts.

**Package Legitimacy Audit: SKIPPED — no new packages installed in this phase.**

---

## Architecture Patterns

### System Architecture Diagram

```
Execution Events (task_spawned, memory_updated, scope_closed)
         │
         ▼
    iii-engine bus
    ┌────────────────────────────────────┐
    │ durable:subscriber                 │
    │   EpisodicMemoryWorker ────────────┼──► episodic_memory (INSERT)
    │     task_spawned + memory_updated  │         │
    │   SemanticMemoryWorker ────────────┼──► semantic_memory (INSERT)
    │     scope_closed                   │         │
    └────────────────────────────────────┘         │
                                                   │ scope_closed + count ≥ 20
    iii-cron (2AM daily)                           ▼
    ┌─────────────────────┐        MemorySynthesizerWorker
    │ MemorySynthesizer   │──────► LLM distillation (ADR 22)
    │ 0 0 2 * * * *       │        semantic_memory + procedural_memory
    └─────────────────────┘                 │
                                            ▼
    iii-cron (3AM daily)            ProceduralMemoryWorker
    ┌─────────────────────┐──────► WL topology embedding (ADR 25, deterministic)
    │ Ebbinghaus decay    │        topology_embedding vector(128) filled
    │ 0 0 3 * * * *       │        superseded_by = id for expired records
    └─────────────────────┘
                                            │
                                            ▼
    HTTP Gateway (Hono)             PostgreSQL
    GET /v1/memory/search ─────────► BM25 (ts_doc @@ plainto_tsquery)
                                    + HNSW (embedding <=> $vec)
                                    → RRF fusion CTE (K=60, 0.6/0.4 weights)
                                    → ranked EventLogNode[] response
    POST /v1/memory/reinforce ─────► UPDATE procedural_memory SET success_count+1
```

### Recommended Project Structure

```
packages/workers/src/
├── memory/                    # NEW — all four Phase 2 memory workers
│   ├── episodic.worker.ts     # EpisodicMemoryWorker (durable:subscriber)
│   ├── semantic.worker.ts     # SemanticMemoryWorker (durable:subscriber)
│   ├── procedural.worker.ts   # ProceduralMemoryWorker (receives synthesizer output)
│   ├── synthesizer.worker.ts  # MemorySynthesizerWorker (cron + scope_closed)
│   └── wl-embedding.ts        # WL kernel embedding logic (deterministic, no LLM)
├── base/
│   graph-handle.ts            # unchanged
│   worker.abstract.ts         # unchanged
├── concrete/
│   conflict-resolver.worker.ts  # EXTEND in Phase 2 — add LLM merge to onConflicted()
├── index.ts                   # ADD: register four new workers + update mem::reflect
```

```
node_modules/@graph/gateway/src/routes/
├── health.ts                  # existing, unchanged
├── topology.ts                # existing, unchanged
├── memory-search.ts           # NEW — GET /v1/memory/search
└── memory-reinforce.ts        # NEW — POST /v1/memory/reinforce
```

### Pattern 1: Cron Worker (iii-sdk, no GraphHandle)

Matches `PatternDiscoveryWorker` pattern exactly. Cron workers do NOT extend `Worker` ABC, do NOT hold a `GraphHandle`, and use a raw `Pool` directly.

```typescript
// Source: node_modules/@graph/workers/src/patterns/discover.worker.ts
export const SYNTHESIZER_CRON_TRIGGER = {
  type: 'cron' as const,
  function_id: 'graph::memory::synthesizer',
  config: { expression: '0 0 2 * * * *' },  // daily 2AM (7-field iii-cron format)
};

export const DECAY_CRON_TRIGGER = {
  type: 'cron' as const,
  function_id: 'graph::memory::decay',
  config: { expression: '0 0 3 * * * *' },  // daily 3AM
};

export class MemorySynthesizerWorker {
  async runSynthesis(pool: Pool, llm: LLMProvider): Promise<void> {
    // Query episodic_memory, call llm.chat(), INSERT into semantic_memory
    // LLM CALL — ADR 22 (distillation, cannot be replaced by deterministic algorithm)
  }

  async runDecay(pool: Pool): Promise<void> {
    // UPDATE procedural_memory SET superseded_by = id
    // WHERE reinforcement_count = 0 AND last_used_at < NOW() - INTERVAL '90 days'
    // Pure SQL, NO LLM call
  }
}
```

### Pattern 2: Event-Triggered Worker (durable:subscriber)

Matches `FrontierSchedulerWorker` pattern. Registers via `registerTrigger` with `durable:subscriber`.

```typescript
// Source: packages/workers/src/scheduler/frontier.worker.ts (pattern)
export const EPISODIC_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::episodic',
  config: { topic: 'graph::memory::episodic::ingest' },
};

// Registration in index.ts (matches existing pattern):
worker.registerFunction('graph::memory::episodic', async (payload: unknown) => {
  const p = payload as { scope_id: string; entity_id: string; content: string };
  await episodicWorker.onEvent(p.scope_id, p.entity_id, p.content, pool);
  return { written: true };
});
worker.registerTrigger(EPISODIC_TRIGGER_CONFIG);
```

### Pattern 3: Direct Memory Table INSERT (NOT occWrite)

The four memory tables (`episodic_memory`, `semantic_memory`, `procedural_memory`, `working_memory`) are standard PostgreSQL tables — not partitioned append-only event log partitions. They use plain INSERT, not the OCC Writable CTE. `occWrite` and `occWriteIdempotent` are only for `execution_event_log`.

The ADR 20 supplement confirms: `tsvector` columns are `GENERATED ALWAYS AS ... STORED` — no application code needed to populate them. Write the `content`/`fact_text`/`intent_description` columns and PostgreSQL automatically computes `ts_doc`.

```typescript
// Episodic INSERT pattern (plain SQL, not OCC)
await pool.query(
  `INSERT INTO episodic_memory (scope_id, entity_id, content, created_at)
   VALUES ($1, $2, $3, NOW())`,
  [scopeId, entityId, writeGuard(content)]
  //                  ^^^^^^^^^ always run writeGuard before storing content
);
// ts_doc is auto-generated by PostgreSQL — no application code needed

// After INSERT, also fire memory_updated event to execution_event_log via occWrite
// (Phase 1 constraint C1: every memory write must also append a memory_updated event)
await occWrite(pool, {
  scopeId, entityId,
  predecessorHash: previousHash,
  payload: { memory_type: 'episodic', content_hash: sha256(content) },
  eventType: 'memory_updated',
});
```

### Pattern 4: writeGuard Usage

`writeGuard` is in `@graph/shared`. It accepts a `string` and returns a `string` with secrets redacted.

```typescript
// Source: node_modules/@graph/shared/src/write-guard.ts
import { writeGuard } from '@graph/shared';

// Always call writeGuard on content before INSERT into any memory table
const safeContent = writeGuard(rawContent);
await pool.query('INSERT INTO episodic_memory ... VALUES ($1)', [safeContent]);
```

Redaction patterns: OpenAI/Anthropic API keys (`sk-...`), AWS keys (`AKIA...`), PostgreSQL connection strings, `<secret>` tags.

### Pattern 5: Hybrid BM25+HNSW RRF Query (ADR 20 supplement, authoritative SQL)

```sql
-- Source: docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md
-- Use plainto_tsquery('simple', ...) NOT to_tsquery() — 'simple' avoids stemming,
-- plainto_tsquery handles arbitrary user text safely (no special chars needed)
WITH
vector_candidates AS (
  SELECT id, content,
         ROW_NUMBER() OVER (ORDER BY embedding <=> $query_embedding) AS vector_rank
  FROM episodic_memory
  ORDER BY embedding <=> $query_embedding
  LIMIT 20
),
bm25_candidates AS (
  SELECT id,
         ts_rank_cd(ts_doc, query) AS bm25_raw_score,
         ROW_NUMBER() OVER (ORDER BY ts_rank_cd(ts_doc, query) DESC) AS bm25_rank
  FROM episodic_memory,
       plainto_tsquery('simple', $query_text) AS query
  WHERE ts_doc @@ query
  ORDER BY bm25_raw_score DESC
  LIMIT 20
),
all_candidates AS (
  SELECT id FROM vector_candidates
  UNION
  SELECT id FROM bm25_candidates
),
rrf_scored AS (
  SELECT
    ac.id,
    0.6 * (1.0 / (60 + COALESCE(vc.vector_rank, 21))) +
    0.4 * (1.0 / (60 + COALESCE(bc.bm25_rank,   21))) AS rrf_score
  FROM all_candidates ac
  LEFT JOIN vector_candidates vc ON ac.id = vc.id
  LEFT JOIN bm25_candidates   bc ON ac.id = bc.id
)
SELECT e.*, r.rrf_score
FROM rrf_scored r
JOIN episodic_memory e ON r.id = e.id
ORDER BY r.rrf_score DESC
LIMIT $final_k;
```

RRF weights: **vector=0.6, bm25=0.4, K=60**. Missing stream penalty rank=21. Apply identically to `semantic_memory` and `procedural_memory`.

The `mem::reflect` final ranking formula adds three signals on top of rrf_score:
`rrf_score × 0.6 + quality × 0.3 + recency × 0.1` (from ROADMAP.md success criterion 1).

### Pattern 6: WL Topology Embedding (deterministic, no LLM)

ADR 25 provides the full algorithm. Phase 2 must compute `topology_embedding vector(128)` when writing procedural templates. This is purely deterministic — no LLM involved.

```typescript
// Source: docs/adr/0027-adr25-cross-domain-topology-algorithm.md
// sha256 is Node.js crypto — no external dependency
import { createHash } from 'crypto';

function computeWLEmbedding(nodes: {id: string; event_type: string}[], edges: {source: string; target: string}[]): Float32Array {
  const histogram = new Map<string, number>();
  const N_DIMS = 128;
  const DEPTH = 3;

  let labels = new Map(nodes.map(n => [n.id, n.event_type]));

  for (let iter = 0; iter < DEPTH; iter++) {
    const newLabels = new Map<string, string>();
    for (const node of nodes) {
      const neighborLabels = edges
        .filter(e => e.target === node.id)
        .map(e => labels.get(e.source)!)
        .sort();
      const hash = createHash('sha256')
        .update(`${labels.get(node.id)}|${neighborLabels.join(',')}`)
        .digest('hex');
      newLabels.set(node.id, hash);
      histogram.set(hash, (histogram.get(hash) ?? 0) + 1);
    }
    labels = newLabels;
  }

  const vec = new Float32Array(N_DIMS);
  for (const [hash, count] of histogram) {
    for (let i = 0; i < 32; i++) {
      const byte = parseInt(hash.slice(i * 2, i * 2 + 2), 16);
      vec[byte % N_DIMS] += count;
    }
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map(v => v / (norm || 1));
}
```

### Pattern 7: LLM Provider Wiring in a Cron Worker

`OpenAICompatibleProvider` is exported from `@graph/shared`. Cron workers receive it as a constructor argument (injected from `index.ts`, not from `process.env` directly).

```typescript
// Source: node_modules/@graph/shared/src/llm/openai-compatible.provider.ts
import { OpenAICompatibleProvider } from '@graph/shared';

// In index.ts (boot entry point only):
const llmProvider = new OpenAICompatibleProvider({
  baseUrl: process.env['LLM_BASE_URL'] ?? 'http://localhost:11434',
  model: process.env['LLM_MODEL'] ?? 'llama3',
  apiKey: process.env['LLM_API_KEY'] ?? '',
});

const synthesizerWorker = new MemorySynthesizerWorker(pool, llmProvider);
worker.registerFunction('graph::memory::synthesizer', async (_payload: unknown) => {
  return synthesizerWorker.runSynthesis();
});
worker.registerTrigger(SYNTHESIZER_CRON_TRIGGER);
```

Every LLM call site in worker code MUST be annotated: `// LLM CALL — ADR 22` per ADR 22 D-1.

### Pattern 8: Gateway Route (Hono, matching health.ts)

```typescript
// Source: node_modules/@graph/gateway/src/routes/health.ts (pattern)
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';

export function buildMemorySearchRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/memory/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const scopeId = c.req.query('scope_id');
    // Validate scopeId as UUID v4 per ADR 24 (REQ-16) before DB query
    // Run hybrid RRF SQL, return results
    // Zod: z.string().uuid() for scope_id
  });

  return app;
}

// Mount in gateway/src/index.ts:
// app.route('/v1', buildMemorySearchRoute(pool));
```

### Anti-Patterns to Avoid

- **Using occWrite/occWriteIdempotent for memory table writes:** These functions target `execution_event_log` partitions only. Memory tables use plain `pool.query('INSERT ...')`.
- **Calling `to_tsquery()` with user input directly:** User input must go through `plainto_tsquery('simple', $user_text)` — `to_tsquery` requires pre-parsed tsquery syntax and will throw on arbitrary text. [VERIFIED: ADR 20 supplement uses `plainto_tsquery`]
- **Using `'english'` dictionary for tsvector queries:** The migration uses `'english'` for `to_tsvector` generation, but ADR 20 supplement specifies `'simple'` for BM25 search queries. Phase 2 search queries should use `plainto_tsquery('simple', ...)` for consistency. [ASSUMED: the `'english'` in migration 003 may cause index miss vs. 'simple' query — verify or use consistent dictionary in both. ADR 20 supplement explicitly chose 'simple' to preserve technical terms.]
- **Computing version_hash in application layer:** Hash is always computed inside the PostgreSQL CTE via pgcrypto. The application provides `canonical_json_text` as TEXT.
- **Reading process.env inside Worker classes:** Only `index.ts` reads env vars and injects providers as constructor arguments.
- **Forgetting Phase 1 constraint C1:** Every write to a memory table MUST also fire a `memory_updated` event to `execution_event_log` via `occWrite`. This records the memory update in the causal chain.
- **Writing to memory tables during Processing lifecycle phase:** Memory workers that extend the `Worker` ABC must obey ADR 27 — DB writes only in `onCompleted()`, not `onRunning()`. Cron workers (using Pool directly, no GraphHandle) are exempt from the lifecycle constraint.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| BM25 text ranking | Custom TF-IDF or full-text scoring | `ts_rank_cd(ts_doc, query)` with GIN index | PostgreSQL native; GIN index already created in migration 003 |
| HNSW vector retrieval | Linear scan, custom ANN | `embedding <=> $vec` with pgvector HNSW index | Index already created in migration 003; pgvector handles ANN correctly |
| RRF fusion ranking | Custom score normalization | Exact SQL CTE from ADR 20 supplement | Formula is locked (K=60, 0.6/0.4 weights); deviation breaks G3-4 |
| Secret/credential redaction | Regex per-worker | `writeGuard(content)` from `@graph/shared` | Already implemented, tested, exported. Covers OpenAI/Anthropic keys, AWS, PG conn strings |
| LLM calls | Raw `fetch()` to OpenAI in workers | `OpenAICompatibleProvider.chat()` from `@graph/shared` | ADR 22 requires all calls via injected provider; raw HTTP in workers is a policy violation |
| Embedding generation | Worker-side embedding computation | `OpenAICompatibleProvider.embed()` injected into worker | Same ADR 22 constraint; embedding calls not counted against W_max |
| WL topology embedding | GNN, GraphSAGE, external ML service | `computeWLEmbedding()` using Node.js `crypto.createHash` | ADR 25 provides full algorithm; deterministic, zero new dependencies |
| Token counting | Manual estimation | `@dqbd/tiktoken` (already in project) | Already used in Phase 1 Context Assembly; sub-1ms per ADR 15 |
| OCC write deduplication | Application-layer unique check | `UNIQUE(predecessor_hash, scope_id)` constraint (already exists) | DB constraint is the authoritative guard; application must still use correct predecessor_hash |

---

## Research Answers: 10 Focus Areas

### 1. iii-sdk Worker Registration Patterns

**Event-triggered worker:** `{ type: 'durable:subscriber', function_id: '...', config: { topic: '...' } }`
**Cron worker:** `{ type: 'cron', function_id: '...', config: { expression: '0 0 2 * * * *' } }` (7-field format: sec min hour day month weekday year)

Import path: `import { registerWorker } from 'iii-sdk'`. Registration in `packages/workers/src/index.ts` ONLY (single boot entry point per existing convention). Cron workers do NOT hold a `GraphHandle` — they use a raw `Pool` directly (matches `PatternDiscoveryWorker`).

[VERIFIED: iii-engine.md, packages/workers/src/index.ts, node_modules/@graph/workers/src/patterns/discover.worker.ts]

### 2. occWriteIdempotent vs occWrite

- **`occWrite`**: use for agent-submitted OCC events that need first-writer-wins semantics (task_spawned, memory_updated to execution_event_log). Used when Phase 1 constraint C1 requires recording a memory write as an event.
- **`occWriteIdempotent`**: use for at-least-once re-delivery idempotency. Returns `null` on duplicate. Hardcodes `event_type = 'memory_updated'`.
- **Plain `pool.query` INSERT**: use for direct writes to the four memory tables (episodic/semantic/procedural/working_memory). These tables are NOT the event log — they use regular INSERT, not OCC CTE.

[VERIFIED: node_modules/@graph/shared/src/occ-write.ts, migrations/003-memory-tables.sql]

### 3. BM25 ts_doc Retrieval

Use `plainto_tsquery('simple', $query_text)` — NOT `to_tsquery()`. `plainto_tsquery` handles arbitrary user input safely and converts it to tsquery syntax. The `'simple'` dictionary matches how the ADR 20 supplement specifies BM25 queries (no stemming, preserves technical terms).

**Schema mismatch to resolve:** Migration 003 generates `ts_doc` using `to_tsvector('english', ...)`, but ADR 20 supplement specifies queries with `'simple'` dictionary. A vector generated with `'english'` and queried with `'simple'` may yield inconsistent results. The planner should decide: either add a migration to change the column to `'simple'` (matching ADR 20 supplement) or use `'english'` in queries too. ADR 20 supplement rationale for `'simple'`: preserves technical terms (error codes, API names) that `'english'` stemming would mangle.

[VERIFIED: docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md, migrations/003-memory-tables.sql]

### 4. HNSW Retrieval and Embedding Placeholder

The `<=>` cosine operator is already available via pgvector (confirmed in migration 003 HNSW index with `vector_cosine_ops`). Phase 2 uses `OpenAICompatibleProvider.embed()` to generate the query embedding at search time. The same provider generates embeddings at write time (when inserting into `semantic_memory.embedding` or `procedural_memory.topology_embedding`).

**Embedding dimensions:**
- `semantic_memory.embedding`: `vector(1536)` — OpenAI-compatible embedding (full semantic embedding)
- `procedural_memory.topology_embedding`: `vector(128)` — WL kernel deterministic computation (NOT LLM)

For the `mem::reflect` HNSW path, `query_text` is embedded by `mem::reflect` internally (ADR 21). Workers pass `query_text` to `mem::reflect`; the function handles embedding generation.

[VERIFIED: migrations/003-memory-tables.sql, docs/adr/0022-adr21-reflection-track-trigger-spec.md]

### 5. RRF Fusion: SQL or TypeScript?

**SQL.** The RRF CTE runs entirely in PostgreSQL. TypeScript receives the final ranked results. This is the correct approach: DB does ranking, TypeScript does serialization.

Weights: `0.6 × vector + 0.4 × bm25`, K=60, missing-stream penalty rank=21.

The `mem::reflect` final ranking adds: `rrf_score × 0.6 + quality × 0.3 + recency × 0.1` — this is a second-pass reranking in TypeScript/SQL after RRF retrieval (procedural_memory only, as per the four-signal query in ADR 20 supplement).

[VERIFIED: docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md]

### 6. MemorySynthesizerWorker LLM Distillation

`OpenAICompatibleProvider` is in `@graph/shared/src/llm/openai-compatible.provider.ts` and exported via `@graph/shared/src/index.ts`. Instantiate in `packages/workers/src/index.ts` (boot entry), inject into `MemorySynthesizerWorker` constructor. Call `provider.chat(messages)` inside the worker's `runSynthesis()` method, annotated `// LLM CALL — ADR 22`.

The synthesizer queries `episodic_memory` for content, calls LLM to distill facts, then writes to `semantic_memory` and proposes `procedural_memory` templates (which `ProceduralMemoryWorker` persists with WL embedding).

[VERIFIED: node_modules/@graph/shared/src/llm/openai-compatible.provider.ts, node_modules/@graph/shared/src/index.ts]

### 7. working_memory TTL Decision

**Unresolved in ADRs.** ADR 20 supplement and the Phase 2 design doc both leave this open. Two valid options:

| Option | Trigger | Complexity |
|--------|---------|------------|
| A: 24-hour DELETE | Cron job (daily 4AM) | Low — single SQL DELETE |
| B: scope_closed cleanup | scope_closed event | Medium — must track which scope_id owns which rows |

The design doc says "default to 24h or scope-close trigger?" — this is an open question for the planner to decide and document in the plan. Option A (24-hour cron) is simpler and avoids tight coupling to scope lifecycle. Option B is more precise but requires scope_closed to cascade cleanup.

**Recommendation:** Use Option A (24h cron, separate from the 3AM decay cron). Add a 4AM cron: `DELETE FROM working_memory WHERE created_at < NOW() - INTERVAL '24 hours'`. [ASSUMED — neither ADR nor design doc specifies TTL; planner must make this decision explicit]

### 8. write-guard Integration

`writeGuard` is already implemented and exported. Call signature:
```typescript
function writeGuard(payload: string): string
```
Pass any text payload before INSERT. It returns the same string with secrets redacted. It does NOT throw — it always returns a string.

[VERIFIED: node_modules/@graph/shared/src/write-guard.ts, node_modules/@graph/shared/src/write-guard.test.ts]

### 9. File Layout for New Workers

New workers go in `packages/workers/src/memory/` (canonical location). The mirror in `node_modules/@graph/workers/src/` reflects the canonical — the build/sync process will propagate changes. Confirmed by git status showing both locations modified in Phase 1. All registrations in `packages/workers/src/index.ts`.

### 10. ConflictResolverWorker Phase 2 Scope

**Partially in Phase 2 scope.** The ROADMAP.md success criterion states "ConflictResolverWorker resolves entity-level conflicts with ActiveResolverRegistry mutex (in-memory)." The Phase 1 stub in `packages/workers/src/concrete/conflict-resolver.worker.ts` has an empty `onConflicted()` method. Phase 2 must:
1. Add `ActiveResolverRegistry` (in-memory mutex, no distributed lock — that is Phase 4)
2. Add LLM-assisted semantic merge in `onConflicted()`
3. Emit resolution result back to execution graph

The mutex prevents concurrent resolution of the same entity conflict. Implementation: a `Map<string, boolean>` keyed by `entity_id` — acquire on `onConflicted()` entry, release on completion.

[VERIFIED: packages/workers/src/concrete/conflict-resolver.worker.ts, .planning/ROADMAP.md]

---

## Common Pitfalls

### Pitfall 1: ts_doc Dictionary Mismatch

**What goes wrong:** Querying with `plainto_tsquery('simple', ...)` against a column generated with `to_tsvector('english', ...)` causes inconsistent tokenization — `'simple'` is case-insensitive but doesn't stem; `'english'` stems (e.g., "running" → "run"). A query for "running" in `'simple'` dictionary against `'english'`-generated `ts_doc` may miss records.

**Why it happens:** Migration 003 used `'english'`, ADR 20 supplement specified `'simple'`.

**How to avoid:** Add migration 004a (or include in Wave 0 tasks) to ALTER the GENERATED ALWAYS columns to use `'simple'`. OR use `'english'` consistently in both column definition and queries. The ADR 20 supplement's rationale for `'simple'` (preserve technical terms) is sound for this domain.

**Warning signs:** `ts_doc @@ plainto_tsquery('simple', 'running')` returns 0 rows when 'running' is in the content.

### Pitfall 2: Writing to execution_event_log Partition with occWrite for Memory Tables

**What goes wrong:** Calling `occWrite(pool, { scopeId, entityId, ... })` to store episodic/semantic/procedural content — this inserts into the OCC event log, not into the memory table.

**Why it happens:** Confusion between the two write paths. Memory tables are separate from `execution_event_log`.

**How to avoid:** Use plain `pool.query('INSERT INTO episodic_memory ...')` for memory tables. Use `occWrite` ONLY for `execution_event_log` events (Phase 1 constraint C1 requires one `memory_updated` event per memory write — fire that separately after the memory INSERT).

### Pitfall 3: 7-Field Cron Expression

**What goes wrong:** Using standard 5-field cron (`0 2 * * *`) for iii-cron triggers — iii uses a 7-field format including seconds and year fields.

**Why it happens:** iii-cron differs from standard Unix cron.

**How to avoid:** Use 7-field format: `'0 0 2 * * * *'` (sec min hour day month weekday year). Confirmed in iii-engine.md research.

**Warning signs:** Cron trigger silently fails to register or fires at wrong time.

### Pitfall 4: Forgetting Phase 1 Constraint C1

**What goes wrong:** Writing to memory tables without also appending a `memory_updated` event to `execution_event_log`. The causal chain is broken — memory writes are invisible to the graph's predecessor hash chain.

**Why it happens:** Memory tables appear to be standalone, but C1 requires every memory write to be traceable in the event log.

**How to avoid:** Every memory INSERT must be followed by `occWrite(pool, { ..., eventType: 'memory_updated' })`. Make this a utility function: `writeMemoryAndRecord(pool, table, content, handle)`.

### Pitfall 5: HNSW Requires Non-NULL Vectors

**What goes wrong:** INSERT into `procedural_memory` with `topology_embedding = NULL` — the HNSW partial index uses `WHERE is_anti_pattern = FALSE` but does NOT exclude NULLs from the index. An HNSW `<=>` query against a NULL vector throws a PostgreSQL error.

**Why it happens:** HNSW indexes only index non-NULL values, but queries must also guard against NULL vectors at query time.

**How to avoid:** Either always compute WL embedding before INSERT (best practice), or add `WHERE topology_embedding IS NOT NULL` to all HNSW queries.

### Pitfall 6: ConflictResolverWorker Race Condition Without Mutex

**What goes wrong:** Two concurrent OCC conflicts on the same entity both enter `onConflicted()` simultaneously, resulting in two LLM merge calls and duplicate resolution events written.

**Why it happens:** iii dispatches events concurrently if parallelism allows it.

**How to avoid:** `ActiveResolverRegistry` is a `Map<entity_id, Promise>` — if an entity is already being resolved, skip or queue. Release the lock in `finally` block.

---

## Code Examples

### Working Memory SHA-256 Dedup (ADR 11 supplement, G3-5)

```typescript
// Source: PHASE2-DESIGN.md §Working Memory dedup, ADR 11 supplement
import { createHash } from 'crypto';

function workingMemoryDedupHash(
  scopeId: string,
  entityId: string,
  eventType: string,
  payloadHash: string
): string {
  return createHash('sha256')
    .update(`${scopeId}|${entityId}|${eventType}|${payloadHash}`)
    .digest('hex');
}

async function insertWorkingMemory(
  pool: Pool,
  scopeId: string,
  entityId: string,
  eventType: string,
  content: string
): Promise<boolean> {
  const payloadHash = createHash('sha256').update(content).digest('hex');
  const dedupHash = workingMemoryDedupHash(scopeId, entityId, eventType, payloadHash);

  // Check 5-minute dedup window
  const existing = await pool.query(
    `SELECT 1 FROM working_memory
     WHERE scope_id = $1
       AND dedup_hash = $2
       AND created_at > NOW() - INTERVAL '5 minutes'
     LIMIT 1`,
    [scopeId, dedupHash]
  );

  if (existing.rows.length > 0) return false; // deduplicated

  await pool.query(
    `INSERT INTO working_memory (scope_id, content, dedup_hash, created_at)
     VALUES ($1, $2, $3, NOW())`,
    [scopeId, writeGuard(content), dedupHash]
  );
  return true;
}
// Note: working_memory table needs a dedup_hash column — migration 004 needed
```

### Ebbinghaus Decay SQL (G3-6)

```typescript
// Source: PHASE2-DESIGN.md §MemorySynthesizerWorker
async function runDecay(pool: Pool): Promise<void> {
  // Logical delete: set superseded_by = id (self-referential, not a physical DELETE)
  await pool.query(`
    UPDATE procedural_memory
    SET superseded_by = id
    WHERE reinforcement_count = 0
      AND last_used_at < NOW() - INTERVAL '90 days'
      AND superseded_by IS NULL
  `);
}
// Note: procedural_memory needs reinforcement_count, last_used_at, superseded_by columns
// These are NOT in migration 003 — a migration 004 or 005 is needed
```

### Procedural Reinforcement SQL (ADR 20 §Reinforcement)

```typescript
// Source: PHASE2-DESIGN.md §ProceduralMemoryWorker
async function reinforce(pool: Pool, templateId: string): Promise<void> {
  await pool.query(
    `UPDATE procedural_memory
     SET success_count = success_count + 1,
         last_used_at = NOW()
     WHERE id = $1`,
    [templateId]
  );
}
```

---

## Schema Gap Analysis (Critical for Planning)

Migration 003 created the four memory tables as **minimal stubs** for Phase 1. Phase 2 requires additional columns. A new migration is needed.

| Table | Missing Columns (Phase 2 needs) | Impact |
|-------|--------------------------------|--------|
| `procedural_memory` | `success_count INT DEFAULT 0`, `failure_count INT DEFAULT 0`, `reinforcement_count INT DEFAULT 0`, `last_used_at TIMESTAMPTZ`, `superseded_by UUID`, `unique_worker_types INT DEFAULT 0` | Reinforcement SQL (ADR 20 Task 1), Ebbinghaus decay (G3-6), four-signal reranking |
| `semantic_memory` | `superseded_by UUID`, `fact_text TEXT` (or use `content`?), HNSW index on `embedding` | Semantic active filter (`WHERE superseded_by IS NULL`), HNSW search on semantic embeddings |
| `working_memory` | `dedup_hash TEXT` (or use UNIQUE constraint on hash columns) | SHA-256 5-min dedup window (G3-5) |
| `episodic_memory` | `entity_id UUID` (for linking back to event log), `intent_summary TEXT`, `outcome_summary TEXT` | ADR 20 supplement references these columns in BM25 weight A/B |

**Resolution:** The planner must include a Wave 0 task: "Add migration 004 to extend memory table schemas with Phase 2 required columns." This migration must not break existing Phase 1 data.

[VERIFIED: migrations/003-memory-tables.sql compared against ADR 20 supplement column references]

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate BM25 (pg_bm25/ParadeDB) | Native `tsvector + ts_rank_cd` | ADR 20 supplement decision | No external extension needed; simpler deployment |
| GNN-based topology embeddings | WL graph kernel (deterministic) | ADR 25 | Zero training data, zero ML infra; computable in Node.js process |
| Per-Worker LLM credentials | `LLMProvider` interface injected via constructor | ADR 22 | Workers are credential-free; provider is a constructor argument |
| `to_tsquery()` with user input | `plainto_tsquery()` for safe user text | ADR 20 supplement | No injection risk from user query strings |

---

## Validation Architecture

nyquist_validation is enabled (`.planning/config.json: workflow.nyquist_validation: true`).

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (confirmed from `node_modules/.vite/vitest/results.json` in git status) |
| Config file | `vitest.config.ts` (verify exists) |
| Quick run command | `npx vitest run --reporter=verbose packages/workers/src/memory/` |
| Full suite command | `npx vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | Notes |
|--------|----------|-----------|-------------------|-------|
| G3-1 | episodic_memory INSERT writes row after task_spawned | integration | `npx vitest run packages/workers/src/memory/episodic.worker.test.ts` | Needs DB |
| G3-2 | semantic_memory synthesis after scope_closed | integration | `npx vitest run packages/workers/src/memory/semantic.worker.test.ts` | Needs DB |
| G3-3 | procedural_memory templates after synthesizer | integration | `npx vitest run packages/workers/src/memory/synthesizer.worker.test.ts` | Needs LLM mock |
| G3-4 | GET /v1/memory/search returns BM25+HNSW ranked results | integration | `npx vitest run node_modules/@graph/gateway/src/routes/memory-search.test.ts` | Needs DB |
| G3-5 | Duplicate tool call within 5min → 1 row in working_memory | unit | `npx vitest run packages/workers/src/memory/dedup.test.ts` | Can mock DB |
| G3-6 | Ebbinghaus decay marks reinforcement_count=0 as superseded | unit | `npx vitest run packages/workers/src/memory/decay.test.ts` | SQL test |
| G3-7 | Gate 2 endpoints regression | integration | `npx vitest run node_modules/@graph/gateway/src/routes/health.test.ts` | Already exists |
| SC-1 | mem::reflect returns rrf_score×0.6+quality×0.3+recency×0.1 ranking | unit | `npx vitest run packages/workers/src/memory/reflect.test.ts` | Math only |
| SC-2 | WL embedding is deterministic for same graph | unit | `npx vitest run packages/workers/src/memory/wl-embedding.test.ts` | Pure function |

### Sampling Rate

- **Per task commit:** `npx vitest run packages/workers/src/memory/`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work` (G3-7 included)

### Wave 0 Gaps (test files to create)

- [ ] `packages/workers/src/memory/episodic.worker.test.ts` — G3-1
- [ ] `packages/workers/src/memory/semantic.worker.test.ts` — G3-2
- [ ] `packages/workers/src/memory/synthesizer.worker.test.ts` — G3-3 (mock LLMProvider)
- [ ] `packages/workers/src/memory/dedup.test.ts` — G3-5
- [ ] `packages/workers/src/memory/decay.test.ts` — G3-6
- [ ] `packages/workers/src/memory/wl-embedding.test.ts` — SC-2 (pure unit test)
- [ ] `packages/workers/src/memory/reflect.test.ts` — SC-1 (ranking math)
- [ ] `node_modules/@graph/gateway/src/routes/memory-search.test.ts` — G3-4

`node_modules/@graph/gateway/src/routes/health.test.ts` already exists (confirmed in git status).

---

## Open Questions

1. **ts_doc dictionary mismatch**
   - What we know: migration 003 uses `'english'`, ADR 20 supplement specifies `'simple'` for queries
   - What's unclear: whether inconsistency causes silent BM25 miss or acceptable overlap
   - Recommendation: Wave 0 task should include migration to align column generation to `'simple'`; test G3-4 will expose failures if mismatched

2. **working_memory TTL**
   - What we know: not specified in any ADR; design doc says "24h or scope-close trigger?"
   - What's unclear: which is canonical
   - Recommendation: Use 24h cron DELETE (simpler, matches Ebbinghaus decay cron pattern); document as explicit decision in plan

3. **working_memory dedup_hash column**
   - What we know: migration 003 has no `dedup_hash` column; G3-5 requires it
   - What's unclear: whether to use a separate column or a UNIQUE constraint on (scope_id, SHA-hash-of-composite)
   - Recommendation: Add `dedup_hash TEXT NOT NULL` + `UNIQUE(scope_id, dedup_hash, created_at)` in migration 004

4. **semantic_memory HNSW index**
   - What we know: migration 003 has `embedding vector(1536)` but no HNSW index on it
   - What's unclear: whether Phase 2 should add the HNSW index now or defer
   - Recommendation: Add HNSW index on `semantic_memory.embedding` in migration 004 (Phase 2 activates hybrid retrieval across all three tables)

5. **mem::reflect registration location**
   - What we know: ADR 21 says it lives in "iii-engine layer"; Phase 1 CONTEXT.md says external agents call `iii.trigger<MemReflectInput, MemReflectOutput>({ function_id: 'mem::reflect', ... })`
   - What's unclear: whether `mem::reflect` is registered in `packages/workers/src/index.ts` or in a separate iii Function registration
   - Recommendation: Register in `packages/workers/src/index.ts` as a `registerFunction('mem::reflect', ...)` alongside the existing workers; this is consistent with Phase 1 registration patterns

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | working_memory TTL should be 24h cron (no ADR specifies this) | Open Questions #2 | TTL too short = loss of intra-session scratch data; too long = storage bloat |
| A2 | ts_doc using 'english' for generation and querying with 'simple' will cause BM25 miss | Pitfall 1, Open Questions #1 | If 'english' and 'simple' produce compatible tokens for this domain, no change needed |
| A3 | mem::reflect is registered in packages/workers/src/index.ts as a normal registerFunction | Open Questions #5 | If it requires a different iii Function type, registration pattern changes |
| A4 | working_memory needs a dedup_hash column added in migration 004 | Schema Gap Analysis | If dedup is implemented via application-layer only (no DB column), migration not needed |

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| PostgreSQL with pgvector | HNSW retrieval, tsvector BM25 | ✓ (confirmed — migration 003 ran) | 15+ | — |
| iii-engine (binary) | Worker registration | ✓ (Phase 1 complete) | 0.16.x | — |
| OpenAI-compatible LLM endpoint | MemorySynthesizerWorker distillation | [ASSUMED] running locally | — | Use mock provider for tests |
| `@graph/shared` LLMProvider | All LLM calls | ✓ (node_modules/@graph/shared/src/llm/) | — | — |
| Vitest | All tests | ✓ (confirmed from git status) | — | — |

---

## Sources

### Primary (HIGH confidence — codebase verified)

- `migrations/003-memory-tables.sql` — actual schema (ts_doc, topology_embedding, HNSW index confirmed)
- `node_modules/@graph/shared/src/write-guard.ts` — writeGuard implementation
- `node_modules/@graph/shared/src/occ-write.ts` — occWrite/occWriteIdempotent signatures
- `node_modules/@graph/shared/src/llm/openai-compatible.provider.ts` — LLMProvider implementation
- `node_modules/@graph/shared/src/llm/provider.interface.ts` — LLMProvider/EmbeddingProvider interfaces
- `node_modules/@graph/shared/src/index.ts` — confirmed LLM exports
- `packages/workers/src/index.ts` — worker registration pattern (authoritative)
- `packages/workers/src/concrete/conflict-resolver.worker.ts` — Phase 1 stub to extend
- `node_modules/@graph/workers/src/patterns/discover.worker.ts` — cron worker pattern
- `node_modules/@graph/gateway/src/routes/health.ts` — Hono route pattern
- `node_modules/@graph/gateway/src/index.ts` — route mounting pattern

### Primary (HIGH confidence — ADR documents)

- `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md` — BM25+RRF SQL templates, weights, K=60
- `docs/adr/0022-adr21-reflection-track-trigger-spec.md` — mem::reflect interface, token budget, trigger types
- `docs/adr/0023-adr22-llm-provider-abstraction.md` — LLM call registry, provider interface
- `docs/adr/0027-adr25-cross-domain-topology-algorithm.md` — WL kernel algorithm, 128-dim embedding

### Primary (HIGH confidence — design doc)

- `.harness/phases/03-execute/PHASE2-DESIGN.md` — Phase 2 scope, worker specs, trigger config, Gate 3 AC

### Secondary (MEDIUM confidence — referenced patterns)

- `.harness/research/iii-engine.md` — iii-sdk trigger types, 7-field cron format, durable:subscriber
- `.planning/phases/01-core-graph-engine/01-CONTEXT.md` — Phase 1 locked decisions, deferred items

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries verified from codebase
- Architecture patterns: HIGH — derived from existing Phase 1 code, ADR SQL templates
- Schema gaps: HIGH — direct comparison of migration 003 vs ADR 20 supplement column references
- Pitfalls: HIGH — derived from ADR documents and codebase inspection
- working_memory TTL: LOW (ASSUMED) — no ADR specifies this

**Research date:** 2026-06-04
**Valid until:** 2026-07-04 (stable domain — PostgreSQL BM25/pgvector APIs are stable; iii-sdk 0.16.x is stable)
