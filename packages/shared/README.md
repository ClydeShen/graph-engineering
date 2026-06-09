<!-- generated-by: gsd-doc-writer -->
# @graph/shared

Shared utilities, types, constants, and Zod schemas for the Graph-Native Agent Runtime. Imported by all packages: control-plane, workers, gateway.

Part of the [graph-enginerring](../../README.md) monorepo.

## Installation

This is a private internal package. Reference it by path via the monorepo workspace.

## Public API

### OCC write helpers

`occWrite(pool, args)` executes the OCC Writable CTE against a PostgreSQL pool. The first writer claims the `predecessor_hash` slot (`occ_result: 'won'`); subsequent writers are appended as `conflict_detected` events (`occ_result: 'demoted'`). Hash computation is performed exclusively by pgcrypto inside the CTE — the application never calls a hash function directly (ADR 02).

`occWriteIdempotent(pool, args)` is the at-least-once re-delivery variant. A duplicate insert with the same `(scope_id, entity_id, version_hash)` silently returns `null`; a new insert returns `WriteResult`. Used by Workers per ADR 36 D-9.

```typescript
import { occWrite, occWriteIdempotent, ZERO_HASH } from '@graph/shared';

// First write into a scope (root node)
const result = await occWrite(pool, {
  scopeId: '...uuid...',
  entityId: '...uuid...',
  predecessorHash: ZERO_HASH,
  payload: { task: 'research quantum computing' },
  eventType: 'task_spawned',
});
// result.occ_result → 'won' | 'demoted'

// Idempotent worker result write
const r = await occWriteIdempotent(pool, { scopeId, entityId, predecessorHash, payload });
// r === null → duplicate (no-op); r → WriteResult → new insert
```

### Canonical JSON

`canonicalJson(payload)` serializes any value to a deterministic JSON string by sorting object keys at every depth (BTreeMap equivalent). `JSON.stringify` is called exactly once on the fully-sorted tree — do not map it over arrays.

`hashablePayload(payload)` strips `_meta` and `schema_version` from a payload object before calling `canonicalJson`. This produces the canonical text passed to PostgreSQL as `$4` in the Writable CTE.

```typescript
import { canonicalJson, hashablePayload } from '@graph/shared';

canonicalJson({ z: 1, a: 2 }); // → '{"a":2,"z":1}'
hashablePayload({ _meta: {}, schema_version: 1, data: 'x' }); // → '{"data":"x"}'
```

### CommandGate

`checkCommand(command)` is a pre-dispatch safety gate for tools that execute shell commands. Returns `{ allowed: true }` or `{ allowed: false, tier: 'hardline' | 'dangerous', reason: string }`.

- **hardline** (12 patterns) — always blocked: filesystem wipes, fork bombs, shutdown/reboot, raw block-device writes.
- **dangerous** (54 patterns) — blocked pending LLM approval: recursive deletes, SQL `DROP`/`TRUNCATE`, force push, sensitive file overwrites, piping remote content to shell, graph-runtime process lifecycle commands.

```typescript
import { checkCommand } from '@graph/shared';

checkCommand('rm -rf /');
// → { allowed: false, tier: 'hardline', reason: 'recursive delete of root filesystem' }

checkCommand('ls -la');
// → { allowed: true }
```

### Key types

| Type | Description |
|---|---|
| `WriteResult` | Return value of `occWrite` / `occWriteIdempotent`: `version_hash`, `event_type`, `occ_result` |
| `EventLogNode` | Single row from `execution_event_log` — all columns including `payload` (TEXT, not JSONB) |
| `GraphWriteEvent` | Input shape for a graph write: `scope_id`, `entity_id`, `event_type`, `predecessor_hash`, `canonical_json_text` |
| `CanonicalEventType` | Union of the five locked event types from `EVENT_TYPES` |
| `GateVerdict` | Return type of `checkCommand` |
| `OccWriteArgs` | Arguments for `occWrite` |

### Zod schemas

`CreateScopeSchema` — validates `POST /v1/scopes` body: `{ intent: string (1–4096 chars) }`.

`EventBodySchema` — validates `POST /v1/scopes/:id/events` body: `event_type` (`'task_spawned' | 'memory_updated'`), `entity_id` (UUID v4), `predecessor_hash` (64-char hex), `payload` (record).

`UUID_V4` and `HASH_HEX64` are the underlying regex constants (ADR 24).

```typescript
import { EventBodySchema } from '@graph/shared';

const parsed = EventBodySchema.parse(req.body); // throws ZodError on invalid input
```

### Constants

| Constant | Value | Description |
|---|---|---|
| `ZERO_HASH` | `'0'.repeat(64)` | Sentinel predecessor hash for root graph nodes (ADR 02) |
| `EVENT_TYPES` | 5-element tuple | Locked canonical event type list (ADR 12) |
| `MAX_PARALLELISM` | `4` | Maximum concurrent Worker slots |
| `MAX_CHILD_SCOPE_DEPTH` | `3` | Maximum nesting depth for child Scopes |
| `MIN_CORPUS_THRESHOLD` | `10` | Minimum completed Scopes before pattern discovery runs |
| `AGENT_HEARTBEAT_TTL_S` | `60` | Heartbeat staleness threshold in seconds |

### Logger

A shared [pino](https://getpino.io) instance. Log level is controlled by the `LOG_LEVEL` environment variable (`debug | info | warn | error`, default `info`).

```typescript
import { logger, LOG_EVENTS } from '@graph/shared';

const log = logger.child({ component: 'gateway', scope_id });
log.info({ version_hash }, LOG_EVENTS.EVENT_WRITTEN);
```

`LOG_EVENTS` is a const object of canonical log event name strings (e.g. `'event.written'`, `'occ.conflict'`, `'llm.call'`). Use these as the pino message argument so log aggregators can group by event type.

### SQL templates

`OCC_WRITE_SQL(partition)` and `OCC_WRITE_DO_NOTHING_SQL(partition)` return the parameterised CTE strings for the two write variants. `partitionTable(scopeId)` derives the per-scope partition table name. These are consumed internally by `occWrite` and `occWriteIdempotent` — use those functions directly rather than calling the SQL templates.
