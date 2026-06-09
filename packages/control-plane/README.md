<!-- generated-by: gsd-doc-writer -->
# @graph/control-plane

Control plane daemon: `pg_notify` pulse-fetch bridge, scope DDL nesting, and HWM tracking.

Part of the [graph-engineering](../../README.md) monorepo.

## What it does

The control plane is the runtime backbone between PostgreSQL and the iii worker mesh. It has three responsibilities:

- **Pulse-Fetch bridge** — subscribes to the `graph_event_ready` pg_notify channel. Each notification carries only an `event_id` (≤64 B signal). The daemon fetches the full event row via point-query on `execution_event_log`, advances the HWM, then routes to the appropriate iii worker.
- **High-Water Mark (HWM)** — persists `last_processed_event_id` per worker in `bus_state`. A conditional `UPDATE ... WHERE last_processed_event_id < $1` prevents HWM regression on duplicate delivery or reconnect replay.
- **Scope DDL nesting** — executes the 3-phase nesting protocol in a single DDL transaction: create partition + OCC constraint + idempotency constraint + pending-lookup index → insert `scope_lineage` row → insert `plan_created` event with pgcrypto `version_hash`. Nesting depth is capped at `MAX_CHILD_SCOPE_DEPTH` (3).

## Boot order

The boot sequence in `startPulseFetch` must follow this order (Pitfall 3 — no gap between LISTEN and HWM read):

1. `subscriber.connect()` — establish dedicated internal pg-listen connection
2. `subscriber.listenTo('graph_event_ready')` — LISTEN before reading HWM
3. `readHwm(pool, 'control-plane')` — read current HWM from `bus_state`
4. Replay missed events: `SELECT … WHERE id > $hwm ORDER BY id ASC LIMIT 1000`

After replay the daemon enters live notification mode via `subscriber.notifications.on()`.

## Event routing

| Event type | iii function_id |
|---|---|
| `sub_scope_resolved` | `graph::scope::sub_scope_resolved` |
| `task_spawned` | `graph::scheduler::frontier` + `graph::memory::episodic` |
| `memory_updated` (agent-originated) | `graph::scheduler::frontier` + `graph::memory::episodic` |
| all others | `graph::scheduler::frontier` |

`sub_scope_resolved` is a Control Plane direct-write — it bypasses the bus enum and does not route to the Frontier Scheduler (ADR 23).

## Starting the daemon

```bash
node --loader ts-node/esm packages/control-plane/src/index.ts
```

## Required environment variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://localhost:5432/graph` | PostgreSQL connection string (read pool + DDL pool) |
| `III_URL` | `ws://localhost:49134` | iii engine WebSocket URL for worker registration |

## Exports

```ts
import { nestScope, createSubScope, resolveSubScope } from '@graph/control-plane/nesting';
import { readHwm, advanceHwm } from '@graph/control-plane/hwm';
import { ScopeConvergenceTracker } from '@graph/control-plane/watchdog';
```

See ADR 05 (control plane architecture), ADR 09 (pulse-fetch bridge), and ADR 23 (sub_scope_resolved routing) for design rationale.
