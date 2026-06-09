<!-- generated-by: gsd-doc-writer -->
# Testing

This document describes the test strategy, conventions, and patterns used in the graph-native agent runtime. The project uses [Vitest](https://vitest.dev/) as the test framework, with three distinct test tiers organized by their infrastructure requirements.

## Test Types

### Unit Tests (`src/__tests__/`)

Unit tests live in `src/__tests__/` and cover core logic that requires no database or network access. These tests run entirely in-process and use `vi.fn()` / `vi.mock()` for all external dependencies.

Examples of what lives here:

| File | What it tests |
|---|---|
| `src/__tests__/worker-lifecycle.test.ts` | Worker phase enforcement, knapsack failure bifurcation |
| `src/__tests__/context-assembly.test.ts` | `ReverseChronologicalDiscarder`, `knapsackSlice` budget logic |
| `src/__tests__/canonical-json.test.ts` | Canonical JSON serialization determinism |
| `src/__tests__/llm-provider.test.ts` | `OpenAICompatibleProvider` — mocked `fetch`, no real network |
| `src/__tests__/gateway.test.ts` | HTTP gateway 400 validation paths — no DB access asserted |

### Package Co-located Tests (`packages/**/*.test.ts`)

Test files sit next to the source they test inside each workspace package. This is the majority of the test surface — Workers, Gateway routes, shared utilities, gateway-bot adapters.

Examples:

| File | What it tests |
|---|---|
| `packages/gateway/src/routes/health.test.ts` | `GET /v1/sys/health` — mocked pool |
| `packages/gateway/src/routes/topology.test.ts` | `GET /v1/scopes/:id/topology` — mocked pool |
| `packages/workers/src/memory/episodic.worker.test.ts` | `EpisodicMemoryWorker` — `vi.mock('@graph/shared')` |
| `packages/workers/src/concrete/conflict-resolver.worker.test.ts` | `ConflictResolverWorker` — mocked LLM + pg advisory lock |
| `packages/gateway-bot/src/router.test.ts` | Gateway bot routing logic |

### DB-Backed Integration Tests

Two locations hold tests that require a live PostgreSQL connection:

- **`tests/integration/`** — foundational graph-engine guarantees (schema, hash chain, OCC, idempotency)
- **`packages/workers/src/memory/gate3.integration.test.ts`** — Phase 2 Memory & Retrieval gate
- **`packages/gateway/src/routes/gate4-mcp.integration.test.ts`** — Phase 3 MCP end-to-end round trip
- **`packages/workers/src/patterns/gate4.integration.test.ts`** — Phase 3 pattern discovery integration

All DB-backed tests use `describe.skipIf(skipIfNoDb())` or `it.skipIf(skip)` so they skip gracefully when `DATABASE_URL` is absent — they never fail CI when no database is available.

## Running Tests

### Run all tests

```bash
npm test
```

Runs `vitest run` across all include globs: `packages/**/*.test.ts`, `src/**/*.test.ts`, `tests/**/*.test.ts`. DB-backed tests are silently skipped if `DATABASE_URL` is not set.

### Run unit tests only

```bash
npm run test:unit
```

Runs only `src/__tests__` — no package tests, no integration tests. Fastest feedback loop; no infrastructure needed.

### Run integration tests only

```bash
npm run test:integration
```

Runs only `tests/integration/` (schema, hash-chain, OCC, idempotency). Requires `DATABASE_URL` to be set; tests skip if it is absent.

### Run all tests with a live database

```bash
npm run test:db
```

This is `scripts/test-with-db.mjs`. It reads `.env` from the project root, injects its variables into the process environment, then runs `vitest run` across all globs. This is the command to use when you want DB-backed integration tests to actually execute rather than skip.

### Run a single test file

```bash
npx vitest run src/__tests__/worker-lifecycle.test.ts
npx vitest run packages/gateway/src/routes/health.test.ts
```

### Filter by test name pattern

```bash
npx vitest run --reporter=verbose -t "Worker lifecycle"
```

## Test Environment Setup

### Unit and package tests

No infrastructure required. Run `npm install` and then `npm run test:unit` or `npm test`.

### DB-backed integration tests

Requirements:

1. **PostgreSQL 15+** running locally (default: `localhost:5432`, database `graph_test`). The Docker Compose setup is the standard way to start it:

   ```bash
   npm run db:up        # docker compose up -d
   npm run db:migrate   # applies all migrations
   ```

2. **`DATABASE_URL` environment variable** — set in `.env` (copy from `.env.example`):

   ```
   DATABASE_URL=postgres://postgres:password@localhost:5432/graph_test
   ```

3. For the Gate 4 MCP end-to-end integration test (`gate4-mcp.integration.test.ts`), the test builds the full Hono app in-process using `buildApp(pool, pool, 4096)` — no running gateway process is needed, but migrations must be applied (001–007).

The `.env.example` contains all required variables:

```
DATABASE_URL=postgres://postgres:password@localhost:5432/graph_test
III_URL=ws://localhost:4001
PORT=4000
LOG_LEVEL=debug
LLM_BASE_URL=http://localhost:11434
LLM_MODEL=llama3
LLM_API_KEY=placeholder
```

The `test:db` script reads `.env` automatically — you do not need to export variables manually.

### DB skip guard

Integration test files use the shared helper from `tests/helpers/pg-test-pool.ts`:

```typescript
import { getTestPool, closeTestPool, skipIfNoDb } from '../helpers/pg-test-pool.js';

describe.skipIf(skipIfNoDb())('my integration suite', () => {
  // ...
});
```

`skipIfNoDb()` returns `true` when `DATABASE_URL` is not set. Tests in package integration files use an equivalent inline pattern:

```typescript
const skip = !process.env['DATABASE_URL'];
it.skipIf(skip)('GATE4-4: ...', async () => { ... });
```

## Test File Conventions

### File naming

- **Unit / package tests** — `*.test.ts` co-located with the source file they test. Example: `episodic.worker.ts` → `episodic.worker.test.ts`.
- **Integration tests** — `*.test.ts` in `tests/integration/` (root-level DB tests) or `*.integration.test.ts` co-located in the package (gate tests).
- **Shared test helpers** — `tests/helpers/` (currently `pg-test-pool.ts`).

### Path aliases in tests

The root `vitest.config.ts` defines the same aliases available in source:

```
@shared         → packages/shared/src
@graph/shared   → packages/shared/src
@graph/workers  → packages/workers/src
@graph/control-plane → packages/control-plane/src
@graph/gateway  → packages/gateway/src
```

Import using these aliases in test files exactly as in source files.

## Writing a New Worker Test

The standard pattern for unit-testing a Worker mocks `@graph/shared` at the module level, then constructs a minimal `pg.Pool` double.

From `packages/workers/src/memory/episodic.worker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

vi.mock('@graph/shared', () => ({
  writeGuard: vi.fn((s: string) => `[guarded]:${s}`),
  occWrite: vi.fn().mockResolvedValue({
    version_hash: 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1',
    event_type: 'memory_updated',
    occ_result: 'won',
  }),
}));

import { writeGuard, occWrite } from '@graph/shared';
import { EpisodicMemoryWorker, EPISODIC_TRIGGER_CONFIG } from './episodic.worker.js';

describe('EpisodicMemoryWorker', () => {
  let mockQuery: ReturnType<typeof vi.fn>;
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    pool = { query: mockQuery } as unknown as Pool;
  });

  it('inserts exactly one row into episodic_memory', async () => {
    const worker = new EpisodicMemoryWorker(pool);
    await worker.onEvent('scope-1', 'entity-1', 'test content', '0'.repeat(64));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO episodic_memory'),
      expect.any(Array),
    );
  });
});
```

Key points:
- `vi.mock('@graph/shared', ...)` must appear before the import of the worker being tested; Vitest hoists it automatically.
- The pool double only needs to implement `query` — cast via `as unknown as Pool`.
- `vi.clearAllMocks()` in `beforeEach` resets call counts between tests.

For workers that test lifecycle phase enforcement, see `src/__tests__/worker-lifecycle.test.ts`. It constructs concrete `Worker` subclasses inline and passes a `makeMockGraphHandle()` fixture:

```typescript
function makeMockGraphHandle(): GraphHandle {
  return {
    scopeId: 'test-scope-001',
    write: vi.fn().mockResolvedValue({ ... } satisfies WriteResult),
    getVersionByHash: vi.fn().mockResolvedValue(null),
    getTailVersionHash: vi.fn().mockResolvedValue('0'.repeat(64)),
    getEpisodicRecords: vi.fn().mockResolvedValue([]),
  };
}
```

## Writing a New Route Test

Route tests construct the Hono route builder directly with a mocked `pg.Pool`. No running server is needed.

From `packages/gateway/src/routes/health.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { buildHealthRoute } from './health.js';

function makePool(liveScopes: number, suspendedCount: number): Pool {
  return {
    query: vi.fn().mockImplementation((sql: string) => {
      if (/live_scopes/.test(sql)) {
        return Promise.resolve({ rows: [{ live_scopes: liveScopes, suspended_count: suspendedCount }] });
      }
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
}

describe('GET /v1/sys/health', () => {
  it('returns 200 with correct shape', async () => {
    const pool = makePool(3, 1);
    const app = buildHealthRoute(pool);
    const res = await app.fetch(new Request('http://localhost/sys/health'));

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      engine_status: 'ok',
      live_scopes: 3,
    });
  });
});
```

For 400 validation paths that must never touch the database, use the spy pool pattern from `src/__tests__/gateway.test.ts`:

```typescript
function makeSpyPool() {
  const spy = vi.fn();
  return {
    pool: { query: spy } as unknown as Pool,
    spy,
  };
}

it('returns 400 and does not call DB when intent is empty', async () => {
  const { pool, spy } = makeSpyPool();
  const app = buildApp(pool, pool, 4096);

  const res = await app.request('/v1/scopes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: '' }),
  });

  expect(res.status).toBe(400);
  expect(spy).not.toHaveBeenCalled();
});
```

The assertion `expect(spy).not.toHaveBeenCalled()` enforces the invariant from ADR 24: Zod validation rejects before any DB access.

## Integration Test Setup and Teardown

DB-backed integration tests manage scope partitions and schema state explicitly. The pattern from `tests/integration/hash-chain.test.ts`:

```typescript
describe.skipIf(skipIfNoDb())('hash-chain integration (REQ-02)', () => {
  const pool = getTestPool();

  beforeAll(async () => {
    await runMigrations(pool);

    // Create an isolated scope partition for this test run
    await pool.query(`
      CREATE TABLE IF NOT EXISTS execution_event_log_scope_${TEST_SCOPE_NODASH}
      PARTITION OF execution_event_log
      FOR VALUES IN ('${TEST_SCOPE_ID}')
    `);
    // Add OCC and idempotency constraints to the partition ...
  });

  afterAll(async () => {
    // Drop the test partition to leave DB clean
    await pool.query(
      `DROP TABLE IF EXISTS execution_event_log_scope_${TEST_SCOPE_NODASH}`
    );
    await closeTestPool();
  });
});
```

Rules:
- Always call `closeTestPool()` in `afterAll`. The pool is lazily shared across the test process; failing to close it leaves dangling connections.
- `runMigrations(pool)` in `beforeAll` is idempotent — safe to call even if migrations already ran.
- Each test run uses a fresh `randomUUID()` as `TEST_SCOPE_ID` to ensure partition isolation. The nodash form (`TEST_SCOPE_NODASH`) is used as the PostgreSQL identifier suffix.
- Clean up created rows and partitions in `afterAll`. Gate tests delete `agent_registry` rows and drop scope partitions from `execution_event_log` using `CASCADE`.

The shared pool helper (`tests/helpers/pg-test-pool.ts`) falls back to `postgres://postgres:postgres@localhost:5432/graph_test` when `DATABASE_URL` is not set, but the skip guard means tests will not run if the env var is absent.

## CI Test Pipeline

No automated CI test pipeline is currently configured. The two GitHub Actions workflows (`project-auto-add.yml`, `project-sync-status.yml`) handle project board management only — they do not run tests.

Gate tests are run manually or via subagent at the end of each development phase, following the process documented in `tests/README.md`:

1. The gate shell script (`tests/test-gate<N>.sh`) is executed against a running `npm run dev` stack.
2. Vitest integration tests run via `npm run test:db` with `DATABASE_URL` pointing to the Docker PostgreSQL instance.
3. Pass/fail is recorded in the phase's UAT document (`.planning/phases/`) before the phase is marked complete.

To run the full suite locally before pushing:

```bash
# Start infrastructure
npm run db:up
npm run db:migrate

# Copy .env.example → .env and fill in values
cp .env.example .env

# Run all tests including DB-backed integration tests
npm run test:db
```
