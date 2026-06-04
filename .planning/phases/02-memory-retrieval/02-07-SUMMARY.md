---
plan: 02-07
status: complete
wave: 3
---

## Working Memory SHA-256 Dedup + ConflictResolverWorker LLM Merge

### Artifacts created

| File | Description |
|---|---|
| `packages/workers/src/memory/working-memory.ts` | `insertWorkingMemory` — SHA-256 dedup, 5-min window, writeGuard |
| `packages/workers/src/memory/working-memory.test.ts` | 5 unit tests — all pass |
| `packages/workers/src/concrete/conflict-resolver.worker.ts` | Plain class rewrite — module-level registry, LLM merge |
| `packages/workers/src/concrete/conflict-resolver.worker.test.ts` | 5 unit tests — all pass |
| `packages/workers/src/index.ts` | conflict-resolver updated: inject `llmProvider`, dispatch `onConflict` |

### insertWorkingMemory behavior

- `insertWorkingMemory(pool, scopeId, entityId, eventType, content): Promise<{ inserted: boolean }>`
- Dedup hash chain: `payloadHash = SHA256(content)`, `dedupHash = SHA256(scopeId|entityId|eventType|payloadHash)`
- SELECT: `WHERE scope_id = $1 AND dedup_hash = $2 AND created_at > NOW() - INTERVAL '5 minutes'`
- If row found → return `{ inserted: false }` (no INSERT)
- INSERT: stores `writeGuard(content)` as content, raw `dedupHash` as dedup_hash
- Returns `{ inserted: true }` on fresh write

### ConflictResolverWorker behavior

- Plain class (not extending Worker ABC) — Phase 2 full implementation
- Module-level `ActiveResolverRegistry = new Map<string, boolean>()` — shared across all instances
- `onConflict(entityId, payloadA, payloadB): Promise<{ merged: string } | { skipped: true }>`
  1. If `entityId` in registry → return `{ skipped: true }` immediately
  2. Set registry entry synchronously (before await) — mutex guarantees
  3. `// LLM CALL — ADR 22` — chat([system, user with writeGuard(payloadA) + writeGuard(payloadB)])
  4. `finally`: delete registry entry (cleanup on both success AND error)
- Error propagates from LLM; registry is cleaned in `finally` ensuring retry is possible

### TDD cycles

- working-memory: RED → import error → GREEN → 5/5 pass → typecheck exits 0
- conflict-resolver: RED → import error → GREEN → 5/5 pass → typecheck exits 0

### Tests (working-memory)

1. Inserts one row when no existing dedup match within 5 minutes → `{ inserted: true }`
2. Returns `{ inserted: false }` without INSERT when identical dedup_hash found within 5 min
3. Proceeds with INSERT when SELECT returns empty (expired window) → `{ inserted: true }`
4. `dedup_hash` deterministic: SELECT params[1] === INSERT params[2] (same 64-char hex)
5. INSERT stores `writeGuard(content)` as content; hash computed from raw content

### Tests (conflict-resolver)

1. Fresh entityId → `llm.chat` called once, returns `{ merged: llmOutput }`
2. EntityId already in registry → returns `{ skipped: true }` without calling LLM
3. LLM throws → registry deleted in `finally`; error propagates; retry succeeds
4. Module-level registry: two separate instances share state (worker1 blocks, worker2 sees it)
5. `writeGuard` called on both payloads; guarded content appears in user message to LLM
