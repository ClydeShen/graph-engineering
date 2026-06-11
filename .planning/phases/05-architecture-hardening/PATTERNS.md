# Phase 5: Architecture Hardening — Pattern Map

**Mapped:** 2026-06-09
**Files analyzed:** 9 new/modified files across 6 ARCH items
**Analogs found:** 9 / 9

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/shared/src/llm/fallback.provider.ts` | service | request-response | `packages/shared/src/llm/anthropic.provider.ts` | exact (LLMProvider impl) |
| `packages/shared/src/llm/classify-error.ts` | utility | transform | `packages/shared/src/write-guard.ts` | role-match (pure function) |
| `packages/gateway/src/routes/stream.ts` | route | streaming | `packages/gateway/src/routes/health.ts` + `packages/control-plane/src/pulse-fetch.ts` | composite |
| `packages/types/src/index.ts` | config | — | `packages/shared/src/index.ts` | exact (barrel re-export) |
| `packages/types/package.json` | config | — | `packages/shared/package.json` | exact (package layout) |
| `packages/shared/src/config/loader.ts` | utility | file-I/O | `packages/cli/src/connect/util.ts` + `packages/cli/src/connect/claude-code.ts` | composite |
| `packages/gateway/src/routes/skills.ts` | route | file-I/O | `packages/gateway/src/routes/memory.ts` | role-match (Hono route) |
| `packages/workers/src/memory/crystallize.worker.ts` | service | CRUD | itself (modify in-place) | exact (existing file) |

---

## Pattern Assignments

### ARCH-01: `packages/shared/src/llm/fallback.provider.ts` (service, request-response)

**Analog:** `packages/shared/src/llm/anthropic.provider.ts` (structure) + `packages/shared/src/llm/factory.ts` (instantiation)

**Imports pattern** (`packages/shared/src/llm/anthropic.provider.ts` lines 11–13):
```typescript
import type { ChatMessage, LLMProvider } from './provider.interface.js';
import type { LLMProviderConfig } from './types.js';
```

**Interface implementation pattern** (`packages/shared/src/llm/anthropic.provider.ts` lines 14–18):
```typescript
export class AnthropicProvider implements LLMProvider {
  private readonly config: LLMProviderConfig;

  constructor(config: LLMProviderConfig) {
    this.config = config;
  }
```

**Error handling pattern** (`packages/shared/src/llm/anthropic.provider.ts` lines 39–44):
```typescript
if (!res.ok) {
  throw new Error(`Anthropic chat request failed: ${res.status} ${res.statusText}`);
}
```

**LLM CALL annotation rule** (`packages/shared/src/llm/anthropic.provider.ts` line 22):
```typescript
// LLM CALL — justified by ADR 22 (Workers call provider interface, not raw HTTP)
```

**Factory registration pattern** (`packages/shared/src/llm/factory.ts` lines 12–23):
```typescript
export function createLLMProvider(config: LLMProviderConfig): LLMProvider {
  switch (config.api) {
    case 'openai-completions':
      return new OpenAICompatibleProvider(config);
    case 'anthropic-messages':
      return new AnthropicProvider(config);
    default: {
      const _exhaustive: never = config.api;
      throw new Error(`Unknown LLM API: ${String(_exhaustive)}`);
    }
  }
}
```

**FallbackProvider shape** — `chat()` must match `LLMProvider` interface exactly (`packages/shared/src/llm/provider.interface.ts` lines 22–24):
```typescript
export interface LLMProvider {
  chat(messages: ChatMessage[], opts?: { temperature?: number }): Promise<string>;
}
```

**Index barrel** — add to `packages/shared/src/llm/index.ts` (current lines 1–6):
```typescript
export * from './types.js';
export * from './provider.interface.js';
export * from './openai-compatible.provider.js';
export * from './anthropic.provider.js';
export * from './factory.js';
// Add: export * from './fallback.provider.js';
// Add: export * from './classify-error.js';
```

---

### ARCH-01 (companion): `packages/shared/src/llm/classify-error.ts` (utility, transform)

**Analog:** `packages/shared/src/write-guard.ts` (pure exported function pattern)

**Pure function export pattern** — write-guard is the codebase's model for a single-purpose utility:
```typescript
// write-guard.ts — copy this structural pattern
export function writeGuard(input: string): string {
  // ...
}
```

`classifyProviderError()` follows the same shape: one exported function, no class, no state.

**Error classification design** (from RESEARCH.md lines 14–43):
```typescript
export type FailoverReason =
  | 'auth'          // 401/403 — throw, do not fallback
  | 'rate_limit'    // 429 — failover to next provider
  | 'overloaded'    // 503 — retry then failover
  | 'timeout'       // fetch timeout — failover
  | 'context_length'// 400+large — throw, do not fallback
  | 'content_filter'// content policy — throw, do not fallback
  | 'unknown';

export interface ClassifiedError {
  reason: FailoverReason;
  shouldFailover: boolean;  // try next provider in chain
  shouldThrow: boolean;     // surface immediately, no retry
  original: Error;
}

export function classifyProviderError(err: unknown): ClassifiedError { ... }
```

---

### ARCH-02: `packages/gateway/src/routes/stream.ts` (route, streaming)

**Analog A (Hono route structure):** `packages/gateway/src/routes/health.ts`

**Route builder pattern** (`packages/gateway/src/routes/health.ts` lines 12–40):
```typescript
import { Hono } from 'hono';
import type { Pool } from 'pg';

export function buildHealthRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/sys/health', async (c) => {
    try {
      // ...
      return c.json<HealthResponse>({ engine_status: 'ok', ... });
    } catch {
      return c.json<HealthResponse>({ engine_status: 'degraded' }, 503);
    }
  });

  return app;
}
```

**Analog B (pg_notify subscriber wiring):** `packages/control-plane/src/pulse-fetch.ts` lines 21–60

```typescript
import createSubscriber from 'pg-listen';
// ...
const subscriber = createSubscriber({ connectionString });
await subscriber.connect();
await subscriber.listenTo('graph_event_ready');
subscriber.notifications.on(CHANNEL, async (rawPayload: unknown) => { ... });
subscriber.events.on('error', (err) => { ... });
```

**SSE response pattern** — Hono `streamSSE` (RESEARCH.md lines 95–101):
```typescript
import { streamSSE } from 'hono/streaming';

app.get('/v1/stream', (c) => {
  return streamSSE(c, async (stream) => {
    const client = await pool.connect();
    await client.query('LISTEN trail_events');
    client.on('notification', (msg) => {
      void stream.writeSSE({ data: msg.payload ?? '' });
    });
    // keep-alive: stream.sleep() or periodic ping
  });
});
```

**Gateway mounting pattern** (`packages/gateway/src/index.ts` lines 49–61):
```typescript
export function buildApp(pool: Pool, ddlPool: Pool, wMax: number): Hono {
  const app = new Hono();
  // existing routes ...
  app.route('/v1', buildStreamRoute(pool));   // add this line
  return app;
}
```

**pg_notify channel** — reuse the existing `'graph_event_ready'` channel from `packages/shared/src/occ-write.ts` line 77. Do NOT create a second channel.

---

### ARCH-03: `packages/types/` new package (config, leaf package)

**Analog (package layout):** `packages/shared/package.json`

**package.json pattern** (`packages/shared/package.json` lines 1–12):
```json
{
  "name": "@graph/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

`packages/types/package.json` should declare zero `@graph/*` deps — it is a leaf. Only `@earendil-works/pi-coding-agent` may appear.

**Barrel re-export pattern** (`packages/shared/src/index.ts` lines 1–18):
```typescript
export * from './canonical-json.js';
export * from './constants.js';
// ...
```

`packages/types/src/index.ts` follows the same barrel shape, re-exporting from three sub-modules:
- `./core.js` — Entity, Snapshot, HyperEdge, Scope, Trail
- `./api.js` — HTTP/MCP wire shapes (extend from `@shared/types.ts`)
- `./shell.js` — SSE event shapes for MemexTerminal

**Type extension pattern** (`packages/shared/src/llm/types.ts` lines 35–42):
```typescript
// Extends Pi SDK type at the type level only — no runtime dep added
import type { ProviderConfig as PiProviderConfig } from '@earendil-works/pi-coding-agent';
export interface LLMProviderConfig extends Pick<PiProviderConfig, 'baseUrl' | 'apiKey'> { ... }
```

Use `extends` or `Pick<>` from Pi SDK types — never duplicate field definitions.

**Existing types to migrate** — move (not duplicate) from `packages/shared/src/types.ts` into `@graph/types/api`:
- `EventLogNode` (lines 17–32)
- `GraphWriteEvent` (lines 39–45)
- `WriteResult` (lines 52–57)

After migration, `@graph/shared` re-exports them from `@graph/types` to preserve existing import paths.

---

### ARCH-04: `packages/shared/src/config/loader.ts` (utility, file-I/O)

**Analog A (JSON read/write with error swallowing):** `packages/cli/src/connect/util.ts` lines 1–11

```typescript
import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';

export function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;   // missing file OR malformed JSON → null, caller decides
  }
}
```

**Analog B (home-dir path construction):** `packages/cli/src/connect/pi.ts` lines 7–9

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';
const PI_DIR = join(homedir(), '.pi');
```

`~/.memex/config.json` path: `join(homedir(), '.memex', 'config.json')`

**Analog C (env-var fallback pattern):** `packages/gateway/src/index.ts` lines 89–92

```typescript
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/graph';
const wMax = Number(process.env.CONTEXT_W_MAX ?? DEFAULT_W_MAX);
```

**Config loader design:**
```typescript
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const CONFIG_PATH = join(homedir(), '.memex', 'config.json');

// Zod schema — follows schemas.ts pattern from packages/shared/src/schemas.ts
export const MemexConfigSchema = z.object({
  gateway: z.object({ port: z.number().default(4000) }).optional(),
  providers: z.array(ProviderEntrySchema).optional(),
  channels: z.record(z.string(), z.unknown()).optional(),
});

export type MemexConfig = z.infer<typeof MemexConfigSchema>;

// Returns null when file missing — callers fall back to env vars (RESEARCH.md risk flag 2)
export function loadMemexConfig(configPath = CONFIG_PATH): MemexConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(resolveEnvVars(raw)) as unknown;
    return MemexConfigSchema.parse(parsed);
  } catch {
    return null;
  }
}
```

**Zod schema pattern** (`packages/shared/src/schemas.ts` lines 1–11):
```typescript
import { z } from 'zod';
export const CreateScopeSchema = z.object({
  intent: z.string().min(1).max(4096),
});
export type CreateScopeInput = z.infer<typeof CreateScopeSchema>;
```

**`${ENV_VAR}` resolution** — scan string values with a regex replace before `JSON.parse`. No external dep.

---

### ARCH-05: `packages/gateway/src/routes/skills.ts` (route, file-I/O)

**Analog:** `packages/gateway/src/routes/memory.ts` (Hono route with two sub-endpoints)

**Two-endpoint route builder pattern** (`packages/gateway/src/routes/memory.ts` lines 50–93):
```typescript
export function buildMemoryRoute(pool: Pool, embedding: EmbeddingProvider): Hono {
  const app = new Hono();

  app.get('/memory/search', async (c) => {
    // validation → query param extraction
    if (!scopeId) return c.json({ error: 'scope_id is required' }, 400);
    try {
      // ...
      return c.json({ results: rows });
    } catch {
      return c.json({ error: 'internal server error' }, 500);
    }
  });

  app.post('/memory/reinforce', async (c) => { ... });

  return app;
}
```

**SKILL.md two-phase loader shape:**
```typescript
// Phase 1: GET /v1/skills — scan directories, read only frontmatter
app.get('/skills', async (c) => {
  // readdir(SKILLS_DIR) → for each subdir, read SKILL.md header lines → parse YAML
  return c.json({ skills: [...] });  // [{ fingerprintId, name, description }]
});

// Phase 2: GET /v1/skills/:id — read full file body on demand
app.get('/skills/:id', async (c) => {
  const id = c.req.param('id');
  // read SKILLS_DIR/id/SKILL.md → return full content
  return c.json({ content: '...' });
});
```

**File read with error swallowing** (follows `packages/cli/src/connect/util.ts` lines 5–10):
```typescript
function readJsonSafe<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}
```

Apply same pattern for SKILL.md reading: return `null` on read error, skip the file.

**SKILLS_DIR env var pattern** (`packages/workers/src/memory/lesson-save.worker.ts` lines 19–21):
```typescript
this.skillsDir = skillsDir ?? process.env['SKILLS_DIR'] ?? './skills';
```

`buildSkillsRoute` takes `skillsDir` as parameter with same env-var default.

**Frontmatter parsing** — existing SKILL.md format from `packages/workers/src/memory/lesson-save.worker.ts` lines 78–91:
```typescript
const frontmatter = [
  '---',
  `name: ${name}`,
  `description: ${description}`,
  'source: graph-runtime',
  `fingerprint_id: ${fingerprintId}`,
  'requires:',
  '  bins: []',
  '  env: []',
  'always: false',
  '---',
  '',
  content,
].join('\n');
```

Parse by splitting on `---`, taking the middle block, splitting on `\n`, and pulling `name:` and `description:` lines. No YAML library needed — fields are simple strings.

**mtime cache key** (RESEARCH.md risk flag 4 — Windows mtime resolution is 100ms):
```typescript
// Use > not >= for cache invalidation on Windows
if (dirStat.mtimeMs > cachedMtime) { /* invalidate */ }
```

---

### ARCH-06: `packages/workers/src/memory/crystallize.worker.ts` (modify in-place, CRUD)

**Analog:** itself — this is a surgical modification to the existing file.

**Current `onScopeClosed` signature** (`packages/workers/src/memory/crystallize.worker.ts` lines 24–51):
```typescript
async onScopeClosed(
  scopeId: string,
  entityId: string,
  predecessorHash: string,
): Promise<{ skipped: true } | { written: true }> {
  const records = await this.reader.getEpisodicRecords(scopeId);
  if (records.length === 0) return { skipped: true };

  const combined = records.join('\n');
  // LLM CALL — ADR 22 (real-time crystallization per scope close)
  const llmOutput = await this.llm.chat([
    { role: 'system', content: 'Distill these execution traces into a concise Crystal...' },
    { role: 'user', content: writeGuard(combined) },
  ]);
```

**Delta injection pattern** — insert existing lesson lookup before the LLM call. Copy the pool query pattern from `packages/workers/src/memory/lesson-save.worker.ts` lines 29–33:
```typescript
const { rows } = await this.pool.query<{ fingerprint_id: string; confidence: number }>(
  `SELECT fingerprint_id, confidence FROM procedural_memory WHERE fingerprint_id = $1 LIMIT 1`,
  [fingerprintId],
);
```

**LLM prompt pattern with delta** (follows the existing chat call structure at lines 30–33):
```typescript
// LLM CALL — ADR 22 (delta crystallization; injects existing lesson to avoid full rewrite)
const llmOutput = await this.llm.chat([
  {
    role: 'system',
    content: existing
      ? 'You are refining an existing lesson. Output ONLY the delta — what changed or was added. Do not repeat unchanged content.'
      : 'Distill these execution traces into a concise Crystal: key insight, pattern, and recommendation. Be brief.',
  },
  {
    role: 'user',
    content: existing
      ? writeGuard(`EXISTING LESSON:\n${existing}\n\nNEW TRAIL EVENTS:\n${combined}`)
      : writeGuard(combined),
  },
]);
```

**`writeGuard` usage** — already imported at line 2 of the file. Do not re-import.

**occWrite pattern** — already present at lines 35–40. The only change is computing `fingerprintId` (SHA-256 of combined trail content) before the LLM call, then using it for the lookup and for the occWrite payload.

**Test pattern** (`packages/workers/src/memory/crystallize.worker.test.ts`):
- Mock structure: `vi.mock('@graph/shared', ...)`, `StubTrailReader`, `mockPool`
- Add test: `it('passes existing lesson content to LLM when lesson exists', ...)`
- Add test: `it('uses full prompt when no existing lesson found', ...)`
- Do NOT change existing test cases — add new ones only (ADR 27 write-timing invariant).

---

## Shared Patterns

### Pattern: LLM CALL annotation
**Source:** `packages/shared/src/llm/anthropic.provider.ts` line 22, `packages/workers/src/memory/semantic.worker.ts` line 29
**Apply to:** Every site in `fallback.provider.ts` that delegates to a concrete `LLMProvider.chat()`
```typescript
// LLM CALL — justified by ADR 22 (Workers call provider interface, not raw HTTP)
```

### Pattern: Error response shape (Hono)
**Source:** `packages/gateway/src/routes/health.ts` lines 32–35, `packages/gateway/src/routes/memory.ts` lines 57–58
**Apply to:** `stream.ts`, `skills.ts`
```typescript
return c.json({ error: 'descriptive message' }, 400);   // client error
return c.json({ error: 'internal server error' }, 500);  // server error
```

### Pattern: Env var reads at package root only
**Source:** `packages/workers/src/index.ts` lines 43–44, `packages/gateway/src/index.ts` lines 89–92
**Apply to:** `loader.ts` (config), `skills.ts` (skillsDir default)
```typescript
// Process-level env reads stay in boot entry points (index.ts) and injectable defaults.
// Modules receive injected values — not process.env reads buried in library code.
const SKILLS_DIR = process.env['SKILLS_DIR'] ?? './skills';  // only at route builder level
```

### Pattern: Zod schema + inferred type
**Source:** `packages/shared/src/schemas.ts` lines 25–42
**Apply to:** `loader.ts` (MemexConfigSchema), `stream.ts` (SSE event type)
```typescript
export const MySchema = z.object({ ... });
export type MyType = z.infer<typeof MySchema>;
```

### Pattern: `buildXxxRoute(pool: Pool): Hono` function
**Source:** every file in `packages/gateway/src/routes/`
**Apply to:** `stream.ts`, `skills.ts`
- Function named `buildXxxRoute`
- Takes `pool: Pool` (and other injected deps) as parameters
- Returns a configured `Hono` instance
- Mounted in `packages/gateway/src/index.ts` via `app.route('/v1', buildXxxRoute(pool))`

### Pattern: `const log = logger.child({ component, route })`
**Source:** `packages/gateway/src/routes/scopes.ts` line 28
**Apply to:** `stream.ts`, `skills.ts`, `loader.ts` (if it logs)
```typescript
const log = logger.child({ component: 'gateway', route: 'GET /v1/stream' });
```

---

## No Analog Found

All 9 files have analogs. No file in Phase 5 requires RESEARCH.md patterns as the sole source.

| File | Notes |
|---|---|
| `packages/shared/src/llm/classify-error.ts` | Closest analog is `write-guard.ts` (same pure-function shape), but error taxonomy comes from RESEARCH.md §ARCH-01 |
| `packages/gateway/src/routes/stream.ts` | SSE via `hono/streaming` is new to this codebase; `pg-listen` EventEmitter pattern from `pulse-fetch.ts` is the closest existing precedent |

---

## Metadata

**Analog search scope:** `packages/shared/src/`, `packages/gateway/src/`, `packages/workers/src/`, `packages/cli/src/`, `packages/control-plane/src/`
**Files scanned:** ~45 TypeScript source files
**Pattern extraction date:** 2026-06-09
