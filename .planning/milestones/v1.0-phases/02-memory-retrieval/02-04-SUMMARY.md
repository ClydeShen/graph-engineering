---
plan: 02-04
status: complete
wave: 2
---

## MemorySynthesizerWorker — Phase 2 cron maintenance workers

### Artifacts created

| File | Description |
|---|---|
| `packages/workers/src/memory/synthesizer.worker.ts` | `MemorySynthesizerWorker` class + 3 cron trigger config exports |
| `packages/workers/src/memory/synthesizer.worker.test.ts` | 6 unit tests — all pass |
| `packages/workers/src/index.ts` | Registration of `graph::memory::synthesizer`, `graph::memory::decay`, `graph::memory::ttl` |

### Behavior

- `runSynthesis()` — queries episodic_memory (LIMIT 100, last 25h); returns `{ skipped: true }` on 0 rows; distils via LLM; returns discriminated union `{ skipped: false; scope_id; intent_description; template_graph; nodes; edges }` with WL-ready node/edge topology
- `runDecay()` — Ebbinghaus decay SQL: `UPDATE procedural_memory SET superseded_by = id WHERE reinforcement_count = 0 AND last_used_at < NOW() - INTERVAL '90 days' AND superseded_by IS NULL` (satisfies G3-6)
- `runTtlPurge()` — `DELETE FROM working_memory WHERE created_at < NOW() - INTERVAL '24 hours'`
- No try/catch in any method — errors propagate to iii-sdk caller
- `readonly base_priority = 1` (matches PatternDiscoveryWorker)

### Triggers

| Export | type | function_id | schedule |
|---|---|---|---|
| `SYNTHESIZER_CRON_TRIGGER` | `cron` | `graph::memory::synthesizer` | `0 0 2 * * * *` |
| `DECAY_CRON_TRIGGER` | `cron` | `graph::memory::decay` | `0 0 3 * * * *` |
| `TTL_CRON_TRIGGER` | `cron` | `graph::memory::ttl` | `0 0 4 * * * *` |

### index.ts synthesizer→procedural link

When `runSynthesis()` returns `{ skipped: false }`, `index.ts` fires `worker.trigger({ function_id: 'graph::memory::procedural', ..., action: TriggerAction.Void() })` — fire-and-forget publish to ProceduralMemoryWorker.

### TDD cycle

RED → import error confirmed → GREEN → 6/6 pass → typecheck exits 0

### Tests

1. `runDecay()` SQL contains `superseded_by = id`, `reinforcement_count = 0`, `INTERVAL '90 days'`
2. `runDecay()` — pool throws → error propagates (no silent swallow)
3. `runTtlPurge()` SQL contains `DELETE FROM working_memory` and `INTERVAL '24 hours'`
4. `runSynthesis()` returns `{ skipped: true }` when 0 rows; LLM not called
5. `runSynthesis()` returns `skipped:false` with `nodes.length === rows.length`, `edges.length === rows.length - 1`
6. Cron trigger config expressions match: synthesizer=2AM, decay=3AM, ttl=4AM
