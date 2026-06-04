---
plan: 02-02
status: complete
commit: 8fe093a
---

## EpisodicMemoryWorker — Phase 2 memory ingest

### Artifacts created

| File | Description |
|---|---|
| `packages/workers/src/memory/episodic.worker.ts` | `EpisodicMemoryWorker` class + `EPISODIC_TRIGGER_CONFIG` export |
| `packages/workers/src/memory/episodic.worker.test.ts` | 5 unit tests — all pass |
| `packages/workers/src/index.ts` | Registration of `graph::memory::episodic` function + durable:subscriber trigger |

### Behavior

- `onEvent(scopeId, entityId, content, predecessorHash)` inserts into `episodic_memory` using `writeGuard(content)` as $3; `ts_doc` not passed (GENERATED ALWAYS)
- C1 constraint: `occWrite(pool, { ..., eventType: 'memory_updated' })` fires after INSERT (best-effort, not transactional)
- Trigger: `durable:subscriber` on topic `graph::memory::episodic::ingest`

### TDD cycle

RED → file didn't exist (load error) → GREEN → 5/5 pass → typecheck clean

### Tests

1. Inserts exactly one row into `episodic_memory`
2. Calls `occWrite` once with `eventType: 'memory_updated'`
3. Stores `writeGuard(content)` as the third INSERT param (not raw content)
4. Does not pass `ts_doc` to INSERT; params length = 3
5. `EPISODIC_TRIGGER_CONFIG` shape matches spec exactly
