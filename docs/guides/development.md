<!-- generated-by: gsd-doc-writer -->
# Development Guide

This guide is for contributors working on MemexCore — the graph-native agent runtime in this repository. It covers repo structure, development workflow, TypeScript setup, how to add Workers and Gateway routes, testing, and the invariants you must not break.

---

## 1. Monorepo Structure

The root `package.json` defines a single npm workspace at `packages/*`. Each package is an ESM module (`"type": "module"`) with its entry point at `src/index.ts`.

```
packages/
├── shared/          @graph/shared   — types, schemas, OCC write, LLM providers, logger
├── workers/         @graph/workers  — 12 iii-registered Workers (Episodic, Semantic, Frontier, …)
├── control-plane/   @graph/control-plane — Pulse-Fetch bridge, Convergence Watchdog, DDL nesting
├── gateway/         @graph/gateway  — Hono HTTP server, REST endpoints, MCP Streamable HTTP
├── gateway-bot/     @graph/gateway-bot  — bot-facing gateway variant (no DDL rights)
├── cli/             @graph/cli      — graph-runtime CLI binary (uses @clack/prompts)
└── pi-extension/    @graph/pi-extension — Pi coding-agent extension hook
```

**Dependency direction:** `gateway` and `workers` depend on `shared` and `control-plane`. `control-plane` depends on `shared`. `shared` depends on nothing in this repo. Never introduce a cycle.

---

## 2. Development Workflow

### Prerequisites

- Node.js >= 18 with `tsx` (installed as devDependency — `npx tsx` works without a global install)
- Bun (used to run the Gateway in dev; `npm run dev` calls `bun run packages/gateway/src/index.ts`)
- Docker (for PostgreSQL + pgvector)
- `iii` binary in PATH (the worker bus engine)

### Starting the stack

```bash
# 1. Copy env template
cp .env.example .env

# 2. Start PostgreSQL
npm run db:up

# 3. Run migrations
npm run db:migrate

# 4. Start all services (iii → workers → control-plane + gateway)
npm run dev
```

`npm run dev` runs `scripts/dev.mjs`, which starts processes in this fixed order:

1. **iii engine** (`iii -c iii-config.yaml`)
2. **Workers** after 2 s — registers all iii functions before Control Plane connects
3. **Control Plane** after 3 s — starts Pulse-Fetch bridge (replays pending DB events immediately)
4. **Gateway** (Bun) — HTTP on `$PORT` (default 4000)

The 2 s / 3 s delays are intentional: Control Plane's Pulse-Fetch replays queued events at connect time; Workers must already have their functions registered or `function_not_found` errors occur.

### Individual service commands

Run any service in isolation during development:

```bash
# Workers only (connects to existing iii)
node --import tsx/esm packages/workers/src/index.ts

# Control Plane only
node --import tsx/esm packages/control-plane/src/index.ts

# Gateway only (Bun required)
bun run packages/gateway/src/index.ts
```

### Type-checking

```bash
npm run typecheck   # tsc --noEmit across all packages
```

### Database helpers

```bash
npm run db:up       # docker compose up -d
npm run db:down     # docker compose down
npm run db:migrate  # run migration scripts via tsx
npm run db:reset    # down -v + up + migrate (full wipe)
```

---

## 3. TypeScript Setup and Path Aliases

`tsconfig.json` at the repo root defines the aliases. The Vitest config (`vitest.config.ts`) mirrors them so tests resolve identically.

| Alias | Resolves to |
|---|---|
| `@graph/shared/*` | `packages/shared/src/*` |
| `@shared/*` | `packages/shared/src/*` (shorthand, same target) |
| `@graph/workers/*` | `packages/workers/src/*` |
| `@graph/control-plane/*` | `packages/control-plane/src/*` |
| `@graph/gateway/*` | `packages/gateway/src/*` |

Use these aliases in all cross-package imports. Never use relative `../../packages/` paths.

```typescript
// correct
import { occWrite, writeGuard } from '@graph/shared';
import { assembleContext } from '@graph/workers/context/assemble';
import { nestScope } from '@graph/control-plane/nesting';

// wrong — relative path across package boundary
import { occWrite } from '../../shared/src/occ-write.js';
```

All packages use `"moduleResolution": "Bundler"` — import paths in source files must end with `.js` (the compiled output extension), not `.ts`, even though the source files are `.ts`.

---

## 4. Adding a New Worker

Workers are iii functions: they receive a payload over WebSocket, do work, and optionally write to the graph. All registration happens in `packages/workers/src/index.ts` — the single boot entry point.

### Step 1: Create the worker file

Create `packages/workers/src/<category>/<name>.worker.ts`. Export your worker class and its trigger config constant:

```typescript
// packages/workers/src/memory/my-feature.worker.ts
import type { Pool } from 'pg';
import { occWrite } from '@graph/shared';

// Trigger config — exported so index.ts registers exactly once
export const MY_FEATURE_TRIGGER_CONFIG = {
  type: 'durable:subscriber' as const,
  function_id: 'graph::memory::my-feature',
  config: { topic: 'graph::memory::my-feature::ingest' },
} as const;

export class MyFeatureWorker {
  constructor(private readonly pool: Pool) {}

  async onEvent(scopeId: string, entityId: string, predecessorHash: string): Promise<void> {
    // All writes go through occWrite — never pool.query INSERT directly
    await occWrite(this.pool, {
      scopeId,
      entityId,
      predecessorHash,
      eventType: 'memory_updated',
      payload: { source: 'my-feature' },
    });
  }
}
```

**Use `memex::` prefix for new event type strings** (e.g., `memex::my-feature::ingest`) per the naming conventions in `CLAUDE.md`. Existing `graph::*` strings are grandfathered.

### Step 2: Register in index.ts

Open `packages/workers/src/index.ts` and add three things:

```typescript
// 1. Import
import { MyFeatureWorker, MY_FEATURE_TRIGGER_CONFIG } from './memory/my-feature.worker.js';

// 2. Instantiate (inside the file, after pool is created)
const myFeatureWorker = new MyFeatureWorker(pool);

// 3. Register function + trigger (in the registration block)
worker.registerFunction('graph::memory::my-feature', async (payload: unknown) => {
  const p = payload as { scope_id: string; entity_id: string; predecessor_hash: string };
  await myFeatureWorker.onEvent(p.scope_id, p.entity_id, p.predecessor_hash);
  return { written: true };
});
worker.registerTrigger(MY_FEATURE_TRIGGER_CONFIG);
```

If the Worker needs an LLM provider or embedding provider, use the `llmProvider` / `embeddingProvider` instances already created in `index.ts`. Do not create new providers inside Worker files — credentials are injected at boot only (ADR 22).

### Step 3: Add an AgentCard entry (if the Worker is external-facing)

Internal infrastructure Workers must have an `agent_registry` row for discoverability. Add a row to the idempotent `INSERT` block near the top of `index.ts`. Use a stable UUID — never `randomUUID()` for AgentCard IDs.

### Worker invariants

- Workers receive injected `pool` / `llmProvider` — they never read `process.env` directly.
- `occWrite` is the only permitted path for appending to `execution_event_log`. Never `pool.query('INSERT INTO execution_event_log ...')` directly from a Worker.
- No DDL from Workers. Partition creation and index creation are exclusively owned by the Control Plane.

---

## 5. Adding a New Gateway Route

The Gateway is a Hono application built by `buildApp()` in `packages/gateway/src/index.ts`. Each route lives in its own file under `packages/gateway/src/routes/`.

### Step 1: Create the route file

```typescript
// packages/gateway/src/routes/my-route.ts
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

// Define input schema — validation happens BEFORE any DB access (ADR 24)
const MyRequestSchema = z.object({
  scope_id: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  value: z.string().min(1).max(256),
});

export function buildMyRoute(pool: Pool): Hono {
  const app = new Hono();

  app.post('/my-endpoint', zValidator('json', MyRequestSchema), async (c) => {
    const { scope_id, value } = c.req.valid('json');

    // SELECT/INSERT only — no DDL (ADR 24)
    const { rows } = await pool.query(
      'SELECT id FROM execution_event_log WHERE scope_id = $1 LIMIT 1',
      [scope_id],
    );

    return c.json({ found: rows.length > 0, value });
  });

  return app;
}
```

Key rules:
- Always use `zValidator('json', Schema)` from `@hono/zod-validator` before any DB access. A 400 must be returned before the DB is touched (ADR 24 / REQ-16).
- For scope UUID params from the URL (e.g., `/:id`), call `validateScopeIdParam(c, id)` from `packages/gateway/src/middleware/zod-guard.ts` after `zValidator`.
- The `pool` passed to route builders has **SELECT + INSERT rights only** — no DDL. DDL goes through the Control Plane via `nestScope()`.

### Step 2: Mount in index.ts

```typescript
// packages/gateway/src/index.ts
import { buildMyRoute } from './routes/my-route.js';

// Inside buildApp():
app.route('/v1', buildMyRoute(pool));
```

### Existing route patterns for reference

| Route file | Method + Path | Notes |
|---|---|---|
| `routes/scopes.ts` | `POST /v1/scopes` | Delegates DDL to `nestScope()` (Control Plane) |
| `routes/events.ts` | `POST /v1/scopes/:id/events` | OCC write + inline Watchdog + context assembly |
| `routes/scope-read.ts` | `GET /v1/scopes/:id` | Read-only scope state |
| `routes/memory.ts` | `GET /v1/memory/search` | Hybrid RRF (vector + BM25) memory search |
| `routes/health.ts` | `GET /v1/health` | DB ping |

---

## 6. Running Tests

The test suite uses Vitest. Path aliases resolve via `vitest.config.ts` (same aliases as `tsconfig.json`).

```bash
# Run all tests (unit + integration)
npm test

# Unit tests only
npm run test:unit

# Integration tests only (require live DB)
npm run test:integration

# Run tests that require a real DB (spins up Docker, runs migrations, then tests)
npm run test:db

# Watch mode (re-runs on save)
npx vitest --watch

# Single file
npx vitest packages/workers/src/memory/episodic.worker.test.ts
```

Test files live alongside their source files: `foo.worker.ts` → `foo.worker.test.ts`. Integration tests use the `.integration.test.ts` suffix and appear in `packages/*/src/**/*.integration.test.ts`.

There are no configured coverage thresholds. The test include pattern is:

```
packages/**/*.test.ts
src/**/*.test.ts
tests/**/*.test.ts
```

---

## 7. Code Style Conventions

The project follows the conventions in `CLAUDE.md`. The short version for day-to-day work:

**Surgical changes** — touch only what your task requires. Do not reformat adjacent code, rename identifiers that aren't broken, or add abstractions for single-use code.

**Naming in new code** — prefer Memex vocabulary for new modules and types:
- Event type strings: `memex::` prefix (e.g., `memex::trail::crystallize`)
- Type names: `Trail`, `Association`, `Lesson`, `Crystallization`
- Do not rename existing stable identifiers (DB column names, existing event strings, existing type exports) — migration cost exceeds value

**Language** — English for all code identifiers, comments, and documentation. Chinese is acceptable in domain docs under `docs/`.

**Env reads** — only in entry point files (`packages/*/src/index.ts`). Worker and provider classes receive injected instances; they never call `process.env` directly (ADR 22).

**No linter or formatter config is currently checked in.** Match the style of the file you are editing.

---

## 8. Key Invariants

These are hard rules enforced by ADRs. Violating them corrupts the Trail Mesh.

### Append-only writes

The `execution_event_log` is immutable. There are no `UPDATE` or `DELETE` statements on this table from application code. State changes are new rows, never edits to existing rows.

### OCC write is the only insert path

All writes to `execution_event_log` go through `occWrite()` (or `occWriteIdempotent()`) from `@graph/shared`. The Writable CTE inside PostgreSQL computes the `version_hash` via `pgcrypto` SHA-256. **The application never computes version hashes** (ADR 02). Do not write raw `INSERT INTO execution_event_log` statements in Workers or the Gateway.

```typescript
// correct
await occWrite(pool, { scopeId, entityId, predecessorHash, eventType: 'memory_updated', payload });

// wrong — bypasses OCC and hash computation
await pool.query('INSERT INTO execution_event_log (scope_id, ...) VALUES ($1, ...)', [...]);
```

### No DDL from the Gateway

The Gateway pool has SELECT + INSERT rights only. Any operation that creates partitions, indexes, or schema objects must go through `nestScope()` in `@graph/control-plane/nesting`, which uses the DDL-exclusive pool owned by the Control Plane (ADR 05, ADR 24).

### Predecessor hash chain

Every event must reference a valid `predecessor_hash`. The root node in a scope uses the `plan_created` event's hash as predecessor. Use `ZERO_HASH` (64 zeros) only for the very first event in a scope where no predecessor exists. Never reuse a predecessor hash — the `UNIQUE(predecessor_hash, scope_id)` constraint will reject it as a conflict (OCC demote).

### payload is TEXT, not JSONB

The `payload` column is `TEXT` containing canonical JSON. Never cast or store it as JSONB. Deserialize with `JSON.parse()` when reading; `hashablePayload()` from `@graph/shared` handles serialization before writes.

### Worker lifecycle: no writes during Processing

Workers use a 4-phase lifecycle: Initializing → Processing → Writing → Terminated. `graph.write()` is forbidden during the Processing phase (enforced by `PhaseGuardedHandle` in `packages/workers/src/base/lifecycle.ts`). Accumulate LLM results in memory; flush them in `onCompleted()`.

---

## Further Reading

- `docs/ARCHITECTURE.md` — three-layer architecture, component diagram, data flow
- `docs/guides/configuration.md` — all environment variables and iii-config.yaml options
- `CLAUDE.md` — behavioral guidelines and Memex vocabulary reference
- `docs/adr/` — Architecture Decision Records (ADR 02, 05, 11, 22, 24, 31 are most relevant for daily work)
