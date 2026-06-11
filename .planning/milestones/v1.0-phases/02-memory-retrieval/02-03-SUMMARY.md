---
plan: 02-03
status: complete
wave: 2
---

## SemanticMemoryWorker — Phase 2 distillation on scope close

### Artifacts created

| File | Description |
|---|---|
| `packages/workers/src/memory/semantic.worker.ts` | `SemanticMemoryWorker` class + `SEMANTIC_TRIGGER_CONFIG` export |
| `packages/workers/src/memory/semantic.worker.test.ts` | 5 unit tests — all pass |
| `packages/workers/src/index.ts` | Registration of `graph::memory::semantic` function + durable:subscriber trigger |

### Behavior

- `onScopeClosed(scopeId, entityId, predecessorHash)` queries `episodic_memory WHERE scope_id = $1 ORDER BY created_at ASC LIMIT 50`
- Returns early (no INSERT, no occWrite) when 0 rows found
- Distils combined content via `llm.chat(...)` with `writeGuard(combined)` as user input (`// LLM CALL — ADR 22`)
- INSERTs into `semantic_memory (scope_id, content, created_at)` with `writeGuard(fact)` — `ts_doc` omitted (GENERATED ALWAYS)
- C1 constraint: `occWrite(pool, { ..., eventType: 'memory_updated' })` fires after INSERT (best-effort, not transactional)
- Trigger: `durable:subscriber` on topic `graph::scope::closed`

### TDD cycle

RED → import error confirmed → GREEN → 5/5 pass → typecheck exits 0

### Tests

1. Queries episodic_memory for the scope and calls llm.chat with combined content
2. Inserts one row into semantic_memory with `writeGuard(llmOutput)` as content param
3. Calls occWrite exactly once with `eventType: 'memory_updated'`
4. Returns early without INSERT or occWrite when episodic_memory returns 0 rows
5. `SEMANTIC_TRIGGER_CONFIG` shape matches spec: durable:subscriber, `graph::memory::semantic`, topic `graph::scope::closed`
