---
plan: 02-05
status: complete
wave: 2
---

## WL Kernel Embedding + ProceduralMemoryWorker — Phase 2 topology templates

### Artifacts created

| File | Description |
|---|---|
| `packages/workers/src/memory/wl-embedding.ts` | `computeWLEmbedding` — Float32Array(128), L2-normalized, deterministic, Node.js crypto only |
| `packages/workers/src/memory/wl-embedding.test.ts` | 5 unit tests — all pass |
| `packages/workers/src/memory/procedural.worker.ts` | `ProceduralMemoryWorker` class + `PROCEDURAL_TRIGGER_CONFIG` export |
| `packages/workers/src/memory/procedural.worker.test.ts` | 5 unit tests — all pass |
| `packages/workers/src/index.ts` | Registration of `graph::memory::procedural` function + durable:subscriber trigger |

### computeWLEmbedding behavior

- 3-iteration Weisfeiler-Lehman label propagation using `createHash('sha256')` from `'crypto'` (no new packages)
- Accumulates label hashes into a 128-dim histogram
- L2-normalizes output: `vec.map(v => v / (norm || 1))` — all-zeros for empty input (no NaN/error)
- Deterministic: same input always produces identical Float32Array

### ProceduralMemoryWorker behavior

- `onSynthesizerOutput(scopeId, entityId, predecessorHash, templateGraph, intentDescription, nodes, edges)`:
  1. `computeWLEmbedding(nodes, edges)` — HNSW guard: embedding always non-NULL before INSERT
  2. Formats as pgvector literal: `[f1,f2,...,f128]`
  3. INSERTs into `procedural_memory` with `topology_embedding` as $5 (never NULL)
  4. C1 constraint: `occWrite(pool, { ..., eventType: 'memory_updated' })` after INSERT (best-effort)
- `reinforce(templateId)`: `UPDATE procedural_memory SET success_count = success_count + 1, last_used_at = NOW() WHERE id = $1`
- Trigger: `durable:subscriber` on topic `graph::memory::synthesizer::output`

### TDD cycles

- wl-embedding: RED → import error → GREEN → 5/5 pass → typecheck exits 0
- procedural: RED → import error → GREEN → 5/5 pass → typecheck exits 0

### Tests (wl-embedding)

1. Returns Float32Array of length 128 for single node
2. L2-norm ≈ 1.0 (within 1e-5) for non-empty input
3. Deterministic: same input twice produces identical output
4. Empty nodes → all-zeros Float32Array(128)
5. Edges affect embedding: graph with edge differs from nodes-only

### Tests (procedural)

1. `onSynthesizerOutput` calls `computeWLEmbedding` with provided nodes/edges; includes bracketed pgvector literal in params
2. INSERT into `procedural_memory` with `topology_embedding` as $5; params length = 5
3. `occWrite` called with `eventType: 'memory_updated'` after INSERT
4. `reinforce()` issues `UPDATE ... SET success_count = success_count + 1` with `[templateId]`
5. `PROCEDURAL_TRIGGER_CONFIG` shape: durable:subscriber, `graph::memory::procedural`, topic `graph::memory::synthesizer::output`
