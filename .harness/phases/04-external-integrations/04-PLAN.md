# Phase 4 Plan — External Integrations

**Phase goal:** Connect the execution graph runtime to external coding agents (Claude Code via MCP, Pi Terminal via extension), add distributed locking for multi-process conflict resolution, wire iii-config.yaml for durable subscriptions, and add a connect CLI for one-command setup.

**Wave structure:**

| Wave | Tasks | Rationale |
|------|-------|-----------|
| 1 | T1 iii-config, T2 pg_try_advisory_lock, T3 InMemoryShadowAdapter | No inter-dependencies; foundation for everything |
| 2 | T4 CrystallizeWorker, T5 packages/pi-extension | Depends on T1 (iii-config correct) and T3 (shadow final) respectively |
| 3 | T6 packages/cli connect CLI | Depends on T5 (pi-extension package stable) |

---

## Task 1: Align iii-config.yaml with required plugins

**Type:** chore
**Effort:** 0.1 context window
**Wave:** 1

### Goal

Add the four missing plugins and fix the observability sampling ratio so durable subscriptions and auto-restart work, and the 137 GB log feedback loop risk is eliminated.

### Acceptance criteria

- [ ] `iii-config.yaml` contains exactly these five top-level worker entries: `iii-worker-manager`, `iii-cron`, `iii-observability`, `iii-queue`, `iii-pubsub`, `iii-state`, `iii-exec` (7 total — iii-worker-manager + iii-cron + 5 additions/modifications)
- [ ] `iii-observability` block contains `sampling_ratio: 0.1`
- [ ] `iii-queue` block contains `adapter: builtin`
- [ ] `iii-pubsub` block contains `adapter: local`
- [ ] `iii-state` block contains `adapter: kv` and `path: .iii-state`
- [ ] `iii-exec` block contains `watch: src/**/*.ts`
- [ ] File is valid YAML (parse without error: `node -e "require('js-yaml').load(require('fs').readFileSync('iii-config.yaml','utf8'))"`)

### Files

- `iii-config.yaml` — add four missing plugin blocks; add `sampling_ratio: 0.1` to existing `iii-observability` block

### Implementation notes

The current file has three workers: `iii-worker-manager`, `iii-cron`, `iii-observability`. Append four new blocks and patch `iii-observability`. The final file must be:

```yaml
workers:
  - name: iii-worker-manager
    config:
      port: 4001

  - name: iii-cron
    config:
      adapter:
        name: kv

  - name: iii-observability
    config:
      enabled: true
      exporter: memory
      logs_enabled: true
      logs_console_output: true
      sampling_ratio: 0.1   # ADR agentmemory issue #519: full sampling caused 137 GB log loop

  - name: iii-queue
    config:
      adapter: builtin       # required for durable:subscriber topic routing

  - name: iii-pubsub
    config:
      adapter: local         # required for durable:subscriber delivery

  - name: iii-state
    config:
      adapter: kv
      path: .iii-state       # persistent KV for trigger registration

  - name: iii-exec
    config:
      watch: src/**/*.ts     # auto-restart Workers on TypeScript source change
```

Do not change any existing field values in `iii-worker-manager` or `iii-cron`. The `sampling_ratio` key is new — add it inside the existing `config` block of `iii-observability`.

---

## Task 2: Replace in-process Map lock with pg_try_advisory_lock

**Type:** feature
**Effort:** 0.2 context window
**Wave:** 1

### Goal

Make `ConflictResolverWorker` distributed-safe by replacing the `Map<string, boolean>` singleton (breaks under multiple Node.js processes) with `pg_try_advisory_lock`, which provides the same non-blocking skip semantics across processes without blocking or deadlocking.

### Acceptance criteria

- [ ] `ActiveResolverRegistry` (the `Map`) is entirely removed from `conflict-resolver.worker.ts`
- [ ] `ConflictResolverWorker` constructor accepts a `Pool` as its second argument: `constructor(llm: LLMProvider, pool: Pool)`
- [ ] `onConflict` calls `SELECT pg_try_advisory_lock(hashtext($1)::bigint)` with `entityId` as the parameter before the LLM call
- [ ] If `pg_try_advisory_lock` returns `false`, `onConflict` returns `{ skipped: true }` immediately (same semantics as before)
- [ ] `pg_advisory_unlock(hashtext($1)::bigint)` is called in the `finally` block to release the lock after the LLM call completes
- [ ] `packages/workers/src/index.ts` passes `pool` as the second argument to `ConflictResolverWorker`
- [ ] Existing test file `packages/workers/src/concrete/conflict-resolver.worker.test.ts` continues to pass (update mocks if needed to supply a `pool` stub)

### Files

- `packages/workers/src/concrete/conflict-resolver.worker.ts` — replace Map with pg_try_advisory_lock
- `packages/workers/src/index.ts` — pass `pool` to ConflictResolverWorker constructor

### Implementation notes

The replacement pattern for the lock guard:

```
// Acquire (non-blocking)
const rows = await pool.query<{ pg_try_advisory_lock: boolean }>(
  'SELECT pg_try_advisory_lock(hashtext($1)::bigint)',
  [entityId],
);
if (!rows.rows[0].pg_try_advisory_lock) return { skipped: true };

try {
  // ... existing LLM call unchanged ...
} finally {
  await pool.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [entityId]);
}
```

`hashtext()` is PostgreSQL's built-in stable string hash within a major version — no external dep needed. The lock is session-scoped: if the process crashes, PostgreSQL auto-releases it when the connection closes. This is correct behaviour (skip semantics, not exclusive ownership).

Do not use `pg_advisory_lock` (blocking variant) — OCC philosophy prohibits blocking locks (04-CONTEXT.md §4).

The `writeGuard` import and the LLM call body are unchanged. Only the locking mechanism changes.

---

## Task 3: Finalize InMemoryShadowAdapter in packages/shared

**Type:** feature
**Effort:** 0.2 context window
**Wave:** 1

### Goal

Promote the spike 003 `InMemoryShadowAdapter` from `.planning/spikes/` into the canonical `packages/shared/src/write-guard.ts` module so it is available as a shared export for `packages/pi-extension`.

### Acceptance criteria

- [ ] `packages/shared/src/write-guard.ts` exports `InMemoryShadowAdapter` class and `ShadowEntry` interface in addition to the existing `writeGuard` function
- [ ] `InMemoryShadowAdapter` constructor signature: `constructor(real: PoolLike)`
- [ ] `PoolLike` interface exported from the same file: `interface PoolLike { query(sql: string, params?: unknown[]): Promise<QueryResult> }`
- [ ] `QueryResult` interface exported: `interface QueryResult<R = Record<string, unknown>> { rows: R[]; rowCount: number | null }`
- [ ] `proxy` getter returns a `PoolLike` that intercepts calls where `sql.trimStart().startsWith('WITH new_version AS')` → captures to internal `ShadowEntry[]`; all other calls pass through to `real`
- [ ] `getEntries()` returns `readonly ShadowEntry[]`
- [ ] `clear()` resets entries to `[]`
- [ ] Fake `WriteResult` for intercepted writes: `{ rows: [{ version_hash: 'shadow::${scopeId}::${entityId}::${Date.now()}', event_type: eventType ?? 'memory_updated', occ_result: 'won' }], rowCount: 1 }`
- [ ] `packages/shared/src/index.ts` exports `InMemoryShadowAdapter`, `ShadowEntry`, `PoolLike`, `QueryResult` from `./write-guard.js`
- [ ] Existing `packages/shared/src/write-guard.test.ts` still passes (it only tests `writeGuard`)
- [ ] New test file `packages/shared/src/shadow-adapter.test.ts` passes all five cases:
  1. OCC write (SQL starts with `WITH new_version AS`) → captured in entries, real pool NOT called, `occ_result === 'won'`
  2. SELECT → passes through to real pool, entries unchanged
  3. Multiple writes accumulate in entries
  4. `clear()` resets entries to empty
  5. `WITH new_version AS` DO NOTHING variant also intercepted

### Files

- `packages/shared/src/write-guard.ts` — append `PoolLike`, `QueryResult`, `ShadowEntry`, `InMemoryShadowAdapter` below existing `writeGuard` function
- `packages/shared/src/index.ts` — add `InMemoryShadowAdapter`, `ShadowEntry`, `PoolLike`, `QueryResult` to re-exports from `./write-guard.js`
- `packages/shared/src/shadow-adapter.test.ts` — new test file (5 test cases listed above)

### Implementation notes

Copy the implementation verbatim from `.planning/spikes/003-shadow-adapter/scripts/shadow-adapter.ts` — it is fully validated. The spike file contains `InMemoryShadowAdapter`, `ShadowEntry`, `PoolLike`, `QueryResult` plus the self-contained test runner. Extract only the class/interface declarations (lines 16–124 of the spike), not the `assert()` / `run()` verification harness — those become the Vitest tests in `shadow-adapter.test.ts`.

The params positional order for OCC writes (from spike line 85): `$1 scopeId, $2 entityId, $3 predecessorHash, $4 canonicalText, $5 eventType`. The `captureWrite` method extracts these by index.

Do not modify `packages/shared/src/occ-write.ts` — it is listed in "files not to touch" in 04-CONTEXT.md.

---

## Task 4: CrystallizeWorker — real-time scope_closed trigger chain

**Type:** feature
**Effort:** 0.3 context window
**Wave:** 2

### Goal

Implement the real-time crystallization path: when a scope closes, immediately trigger LLM digest into a Crystal entity and then dedup-save a Lesson, running in parallel with the existing 2AM batch `MemorySynthesizerWorker`.

### Acceptance criteria

- [ ] New file `packages/workers/src/memory/crystallize.worker.ts` exists and exports `CrystallizeWorker` class and `CRYSTALLIZE_TRIGGER_CONFIG` constant
- [ ] `CRYSTALLIZE_TRIGGER_CONFIG` is `{ type: 'durable:subscriber', function_id: 'graph::memory::crystallize', config: { topic: 'graph::scope::closed' } }`
- [ ] `CrystallizeWorker.onScopeClosed(scopeId, entityId, predecessorHash)` executes this sequence:
  1. Queries `episodic_memory` for all records where `scope_id = $1` ordered by `created_at ASC` (no time window — captures all)
  2. If no records, returns `{ skipped: true }`
  3. Calls `llm.chat([{ role: 'system', content: 'Distill these execution traces into a concise Crystal: key insight, pattern, and recommendation. Be brief.' }, { role: 'user', content: writeGuard(combined) }])` (ADR 22 — LLM call for digest)
  4. Writes Crystal to `execution_event_log` via `handle.write({ scope_id: scopeId, entity_id: entityId, event_type: 'memory_updated', predecessor_hash: predecessorHash, canonical_json_text: canonicalJson({ crystal: llmOutput, source: 'crystallize', scope_id: scopeId }) })`
  5. Calls `sdk.trigger({ function_id: 'graph::memory::lesson-save', payload: { content: llmOutput, confidence: 0.6 }, action: TriggerAction.Void() })`
- [ ] New file `packages/workers/src/memory/lesson-save.worker.ts` exists and exports `LessonSaveWorker` class and `LESSON_SAVE_TRIGGER_CONFIG` constant
- [ ] `LESSON_SAVE_TRIGGER_CONFIG` is `{ type: 'durable:subscriber', function_id: 'graph::memory::lesson-save', config: { topic: 'graph::memory::lesson-save' } }`
- [ ] `LessonSaveWorker.onLessonSave({ content, confidence })` executes:
  1. Computes `fingerprintId = createHash('sha256').update(content).digest('hex')`
  2. Queries `procedural_memory` for a row where `fingerprint_id = $1` (assumes column exists from Phase 3 migration)
  3. If existing: runs `UPDATE procedural_memory SET confidence = LEAST(1.0, confidence + 0.1 * (1 - confidence)), reinforcement_count = reinforcement_count + 1 WHERE fingerprint_id = $1` (Ebbinghaus reinforcement formula)
  4. If new: runs `INSERT INTO procedural_memory (fingerprint_id, content, confidence, decay_rate, reinforcement_count, last_used_at, superseded_by) VALUES ($1, $2, 0.5, 0.05, 0, NOW(), NULL)` — uses `confidence=0.5` (initial), `decay_rate=0.05` (per 04-CONTEXT.md §2)
  5. Returns `{ fingerprint_id: fingerprintId, action: 'reinforced' | 'created' }`
- [ ] Both workers registered in `packages/workers/src/index.ts`:
  - `worker.registerFunction('graph::memory::crystallize', ...)` + `worker.registerTrigger(CRYSTALLIZE_TRIGGER_CONFIG)`
  - `worker.registerFunction('graph::memory::lesson-save', ...)` + `worker.registerTrigger(LESSON_SAVE_TRIGGER_CONFIG)`
- [ ] `CrystallizeWorker` AgentCard inserted in the boot-time `INSERT INTO agent_registry` block in `index.ts` with stable UUID `'a1000000-0000-4000-8000-000000000008'`, skills `ARRAY['memory-storage', 'crystallization']`
- [ ] `LessonSaveWorker` AgentCard inserted with stable UUID `'a1000000-0000-4000-8000-000000000009'`, skills `ARRAY['memory-storage', 'lesson-dedup']`
- [ ] Tests: `packages/workers/src/memory/crystallize.worker.test.ts` covers: skipped when no episodic records, trigger fired with `confidence: 0.6` when records exist. `packages/workers/src/memory/lesson-save.worker.test.ts` covers: creates new lesson (confidence=0.5), reinforces existing (confidence increases by formula), dedup prevents duplicate insert.

### Files

- `packages/workers/src/memory/crystallize.worker.ts` — new file
- `packages/workers/src/memory/lesson-save.worker.ts` — new file
- `packages/workers/src/index.ts` — register both workers; add two AgentCard rows
- `packages/workers/src/memory/crystallize.worker.test.ts` — new test file
- `packages/workers/src/memory/lesson-save.worker.test.ts` — new test file

### Implementation notes

Model `CrystallizeWorker` closely after `SemanticMemoryWorker` (`packages/workers/src/memory/semantic.worker.ts`) — same constructor shape `(pool: Pool, llm: LLMProvider)`, same `handle` pattern, same `writeGuard` usage around the LLM input.

`canonicalJson` is exported from `@graph/shared` as `canonicalJson` (from `canonical-json.ts`). Use it to build the `canonical_json_text` for the Crystal write.

`sdk.trigger` is the `worker` instance from `registerWorker` — `CrystallizeWorker` needs `worker` (the TriggerAction emitter) injected or passed to `onScopeClosed`. Pattern: accept it as a third constructor arg `private readonly sdk: { trigger: typeof worker['trigger'] }`, mirroring how `index.ts` already passes `worker` as the SDK reference for trigger calls.

The `MemorySynthesizerWorker` (2AM cron) is not modified. Both paths coexist and are independent — the crystallize path is real-time per-scope, the synthesizer is batch across all scopes.

The `procedural_memory` table must have a `fingerprint_id` column (type `TEXT`) and a `confidence` column (type `FLOAT`). If the column does not exist in the current schema, add a migration file `packages/workers/src/memory/migrations/004-add-fingerprint-id.sql` with `ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS fingerprint_id TEXT; ALTER TABLE procedural_memory ADD COLUMN IF NOT EXISTS confidence FLOAT NOT NULL DEFAULT 0.5; CREATE UNIQUE INDEX IF NOT EXISTS procedural_memory_fingerprint_id_idx ON procedural_memory (fingerprint_id) WHERE fingerprint_id IS NOT NULL;` — and note this in `.harness/implementation-notes.md`.

---

## Task 5: packages/pi-extension — Pi extension package

**Type:** feature
**Effort:** 0.3 context window
**Wave:** 2

### Goal

Create the `packages/pi-extension` package that Pi loads as an extension, providing `spawn_task`, `complete_task`, rehearsal mode (via `InMemoryShadowAdapter`), and the `/fork-ext` + `/fork-end` commands.

### Acceptance criteria

- [ ] Directory `packages/pi-extension/` exists with the structure:
  ```
  packages/pi-extension/
    src/
      index.ts              ← extension factory (default export)
      pi-types.shim.ts      ← ExtensionAPI type shim
    package.json
    tsconfig.json
  ```
- [ ] `packages/pi-extension/package.json` contains:
  - `"name": "@graph/pi-extension"`
  - `"private": true`
  - `"pi": { "extensions": ["./src/index.ts"] }` — Pi extension loader entry
  - `"dependencies": { "@graph/shared": "workspace:*", "@earendil-works/pi-coding-agent": "*" }`
- [ ] `src/pi-types.shim.ts` is a copy of `.planning/spikes/004-pi-extension/extension/src/pi-types.shim.ts` (verified Pi API shim — no modifications)
- [ ] `src/index.ts` implements the `graphRuntimeExtension(pi: ExtensionAPI)` factory with all six registrations:
  1. `pi.on('session_start', ...)` — logs `[INTERACTIVE]` or `[REHEARSAL]` mode with `GRAPH_RUNTIME_URL`
  2. `pi.on('session_before_fork', ...)` — activates `InMemoryShadowAdapter` (guard against double-activation)
  3. `pi.on('tool_call', ...)` — blocks `rm`, `git push`, `git commit`, `psql` bash commands in rehearsal; asks `ctx.ui.confirm` (blocking prompt); returns `{ block: true, reason: '...' }` if user declines
  4. `pi.registerTool('spawn_task', ...)` — calls `fetch(GRAPH_RUNTIME_URL + '/mcp', { method: 'POST', body: JSON.stringify({ tool: 'spawn_task', params }) })`; in rehearsal mode `callMcp` logs mode and shadow entry count instead of real fetch (stub safe for Phase 4 — real MCP call wired here but shadow always intercepts the write path via the adapter, not the fetch)
  5. `pi.registerTool('complete_task', ...)` — same fetch pattern with `tool: 'complete_task'`
  6. `pi.registerCommand('fork-ext', ...)` — `ctx.fork(entryId)` + `activateShadow`; guard already-active
  7. `pi.registerCommand('fork-end', ...)` — `shadow.clear(); activeShadow = null`; logs count destroyed
- [ ] Module-level `activeShadow: InMemoryShadowAdapter | null = null` singleton manages rehearsal state
- [ ] `InMemoryShadowAdapter` imported from `@graph/shared` (not from spike path)
- [ ] `GRAPH_RUNTIME_URL` read from `process.env['GRAPH_RUNTIME_URL'] ?? 'http://localhost:4000'`
- [ ] `packages/pi-extension/tsconfig.json` extends the root tsconfig with `"moduleResolution": "bundler"` (or matches root config — do not invent new settings)
- [ ] TypeScript compiles without errors: `tsc --noEmit` in `packages/pi-extension/`

### Files

- `packages/pi-extension/src/index.ts` — new file (based on spike 004 validated logic)
- `packages/pi-extension/src/pi-types.shim.ts` — new file (copy from spike 004)
- `packages/pi-extension/package.json` — new file
- `packages/pi-extension/tsconfig.json` — new file

### Implementation notes

The implementation is a direct promotion of spike 004 (`.planning/spikes/004-pi-extension/extension/src/index.ts`). Key differences from the spike:

1. Import `InMemoryShadowAdapter` from `@graph/shared` instead of the relative spike path.
2. Remove the mock `realPool` from `activateShadow` — in the real extension, the Pi extension does not hold a `pg.Pool`. The `InMemoryShadowAdapter` is constructed with a no-op pool (`{ query: async () => ({ rows: [], rowCount: 0 }) }`) because the extension itself never queries PostgreSQL directly — it only intercepts calls that would go through the MCP fetch path. This is identical to the spike's mock pool and is intentional: the shadow captures the write intent, not a real DB write.
3. The `callMcp` function makes a real `fetch` to `GRAPH_RUNTIME_URL + '/mcp'`. In rehearsal mode, keep the call but note in the response that it is in rehearsal (the write interception happens inside the runtime, not at the fetch layer). For Phase 4, the stub behaviour from the spike (returning a mode/args object without real fetch) is acceptable — mark with `// TODO Phase 5: wire real fetch` comment.

The `activateShadow` function uses a guard: `if (activeShadow) return;` — prevents double-activation if both `session_before_fork` and `/fork-ext` fire in the same session.

`pi.registerCommand` handler receives `ExtensionCommandContext` (has `ctx.fork()`). Event handlers receive `ExtensionContext` (no `fork()`). This distinction is already correct in the spike — do not flatten the types.

---

## Task 6: packages/cli — connect CLI

**Type:** feature
**Effort:** 0.3 context window
**Wave:** 3

### Goal

Create the `packages/cli` package with the `graph-runtime` bin that wires Claude Code (MCP) and Pi Terminal (extension) in one command, with interactive `@clack/prompts` UX, backup-before-write safety, and idempotent re-runs.

### Acceptance criteria

- [ ] Directory `packages/cli/` exists with the structure:
  ```
  packages/cli/
    src/
      connect/
        claude-code.ts
        pi.ts
        util.ts
      index.ts
    package.json
    tsconfig.json
  ```
- [ ] `packages/cli/package.json` contains:
  - `"name": "@graph/cli"`
  - `"bin": { "graph-runtime": "./src/index.ts" }`
  - `"dependencies": { "@clack/prompts": "^0.9.0", "@graph/pi-extension": "workspace:*", "@graph/shared": "workspace:*" }`
- [ ] `src/connect/util.ts` exports three functions:
  - `readJsonSafe<T>(path: string): T | null` — tries `JSON.parse(readFileSync(path, 'utf8'))`, returns `null` on error
  - `writeJsonAtomic(path: string, data: unknown): void` — writes to `${tmpdir()}/.graph-tmp-${process.pid}-${randomBytes(4).toString('hex')}.json` then `renameSync(tmp, path)`
  - `backupIfExists(path: string): string | null` — if file exists, copies to `${path}.bak-${Date.now()}`, returns backup path; returns `null` if file does not exist
- [ ] `src/connect/claude-code.ts` exports `connectClaudeCode(opts?: { force?: boolean }): Promise<ClaudeCodeResult>` where `ClaudeCodeResult = { kind: 'installed' | 'already-wired' | 'dry-run'; backup: string | null }`
  - Reads `~/.claude.json` via `readJsonSafe`
  - Idempotent check: if `mcpServers['graph-runtime']` already exists and `!opts.force`, returns `{ kind: 'already-wired', backup: null }`
  - Backs up `~/.claude.json` via `backupIfExists`
  - Patches `mcpServers` object: adds `'graph-runtime': { type: 'http', url: '${GRAPH_RUNTIME_URL:-http://localhost:4000}/mcp' }`
  - If `process.env['GRAPH_RUNTIME_SECRET']` is set, also adds `headers: { Authorization: 'Bearer ${process.env['GRAPH_RUNTIME_SECRET']}' }` to the entry
  - Writes patched object back via `writeJsonAtomic`
  - Returns `{ kind: 'installed', backup: <backup path or null> }`
- [ ] `src/connect/pi.ts` exports `connectPi(opts?: { force?: boolean }): Promise<PiResult>` where `PiResult = { kind: 'installed' | 'already-wired' | 'no-pi' | 'dry-run'; extDir?: string; backup?: string | null; note?: string }`
  - Detects Pi via `existsSync(join(homedir(), '.pi'))`
  - Idempotent check on `~/.pi/agent/settings.json`: `extensions[]` array contains a path with `graph-runtime` → return `{ kind: 'already-wired', ... }` unless `opts.force`
  - Creates `~/.pi/agent/extensions/graph-runtime/src/` directory recursively
  - Copies `packages/pi-extension/src/index.ts` and `packages/pi-extension/src/pi-types.shim.ts` into the extension directory
  - Writes `~/.pi/agent/extensions/graph-runtime/package.json` via `writeJsonAtomic` (same structure as `packages/pi-extension/package.json`)
  - Backs up `~/.pi/agent/settings.json` via `backupIfExists`
  - Patches `settings.json`: adds extension dir to `extensions[]` array (additive — preserves existing entries, deduplicates graph-runtime)
  - Post-write verification: re-reads settings and confirms `isAlreadyWired` is true; throws if not
  - Returns `{ kind: 'installed', extDir, backup }`
- [ ] `src/index.ts` is the CLI entrypoint:
  - Uses `@clack/prompts` for interactive flow
  - `intro('graph-runtime connect')` at start
  - `multiselect` prompt: "Which agents to connect?" with options `[{ value: 'claude-code', label: 'Claude Code (MCP)' }, { value: 'pi', label: 'Pi Terminal (extension)' }]`
  - Calls `connectClaudeCode()` and/or `connectPi()` based on selection
  - Prints `outro` with summary of what was installed / already-wired / skipped
  - Exits with code 0 on success, 1 on unhandled error
- [ ] Running `node packages/cli/src/index.ts --help` or `graph-runtime --help` exits 0 and prints usage (minimum: lists the two agent options)
- [ ] TypeScript compiles without errors: `tsc --noEmit` in `packages/cli/`

### Files

- `packages/cli/src/connect/util.ts` — new file
- `packages/cli/src/connect/claude-code.ts` — new file
- `packages/cli/src/connect/pi.ts` — new file
- `packages/cli/src/index.ts` — new file
- `packages/cli/package.json` — new file
- `packages/cli/tsconfig.json` — new file

### Implementation notes

`src/connect/pi.ts` is a direct promotion of spike 005 (`.planning/spikes/005-connect-pi/scripts/connect-pi.ts`). Key differences from the spike:

1. `readJsonSafe`, `writeJsonAtomic`, `backupIfExists` are imported from `./util.ts` (not inlined).
2. The extension source files are copied from the resolved location of `packages/pi-extension` in the monorepo (`join(__dirname, '../../../pi-extension/src/')` or via a workspace-resolved path) rather than hardcoded relative paths.
3. `DRY_RUN` env var check is removed — dry-run is not needed in the production CLI. The `@clack/prompts` flow handles user confirmation before acting.

`src/connect/claude-code.ts` follows the exact same backup-atomic-idempotent pattern. The MCP URL defaults to `http://localhost:4000/mcp` but uses the template `${GRAPH_RUNTIME_URL:-http://localhost:4000}/mcp` as a literal string value in the JSON (not shell expansion — write the literal value with the env var resolved at install time: `const url = (process.env['GRAPH_RUNTIME_URL'] ?? 'http://localhost:4000') + '/mcp'`).

`@clack/prompts` version `^0.9.0` — use `intro`, `outro`, `multiselect`, `spinner`, `log.success`, `log.warn` from the package. No other UI library.

The `--help` flag: handle `process.argv.includes('--help')` at the top of `index.ts` before the `@clack/prompts` flow — print a brief usage string to stdout and `process.exit(0)`.

Do not add a Vitest test file for the CLI itself in Phase 4 — the connect functions touch the filesystem (home directory) and require integration test setup beyond Phase 4 scope. Verify via manual dry-run in the checkpoint below.

---

## Task 7: Manual verification checkpoint

**Type:** checkpoint:human-verify
**Effort:** N/A
**Wave:** 3

### Goal

Verify that the full integration chain works end-to-end before Phase 4 is marked complete.

### What was built

- T1: `iii-config.yaml` aligned — durable subscriptions now functional
- T2: `ConflictResolverWorker` uses `pg_try_advisory_lock` — safe under multiple processes
- T3: `InMemoryShadowAdapter` exported from `@graph/shared`
- T4: `CrystallizeWorker` + `LessonSaveWorker` registered — real-time crystallization path active
- T5: `packages/pi-extension` ready for Pi to load
- T6: `packages/cli` with `graph-runtime` bin

### Verification steps

1. YAML parse check:
   ```
   node -e "require('js-yaml').load(require('fs').readFileSync('iii-config.yaml','utf8')); console.log('OK')"
   ```
   Expected: prints `OK`.

2. TypeScript compile — shared:
   ```
   cd packages/shared && npx tsc --noEmit
   ```
   Expected: exits 0, no errors.

3. TypeScript compile — workers:
   ```
   cd packages/workers && npx tsc --noEmit
   ```
   Expected: exits 0, no errors.

4. TypeScript compile — pi-extension:
   ```
   cd packages/pi-extension && npx tsc --noEmit
   ```
   Expected: exits 0, no errors.

5. TypeScript compile — cli:
   ```
   cd packages/cli && npx tsc --noEmit
   ```
   Expected: exits 0, no errors.

6. Unit tests — shared (includes shadow-adapter tests):
   ```
   cd packages/shared && npx vitest run
   ```
   Expected: all tests pass, including `shadow-adapter.test.ts` 5 cases.

7. Unit tests — workers (includes crystallize + lesson-save + conflict-resolver):
   ```
   cd packages/workers && npx vitest run
   ```
   Expected: all tests pass.

8. CLI help flag:
   ```
   node packages/cli/src/index.ts --help
   ```
   Expected: exits 0, prints usage text mentioning `claude-code` and `pi`.

9. CLI dry-run (Claude Code only — no actual `~/.claude.json` risk):
   ```
   GRAPH_CONNECT_DRY_RUN=1 node packages/cli/src/index.ts
   ```
   Select `Claude Code` only. Expected: reports `already-wired` or `installed` without crashing.

### Resume signal

Reply `approved` when all 9 checks pass. If any check fails, describe which step failed and the error output.

---

## Phase 4 success criteria

- `iii-config.yaml` has 7 plugin blocks; `sampling_ratio: 0.1` present in `iii-observability`
- `ConflictResolverWorker` contains no `Map` and contains `pg_try_advisory_lock`
- `InMemoryShadowAdapter` is importable from `@graph/shared`
- `graph::memory::crystallize` and `graph::memory::lesson-save` are registered in `index.ts`
- `packages/pi-extension/` exists with valid `package.json` containing `"pi": { "extensions": [...] }`
- `packages/cli/` exists with `graph-runtime` bin; `connectClaudeCode` and `connectPi` are exported
- All unit tests pass (`vitest run` in `packages/shared` and `packages/workers`)
- All TypeScript packages compile without errors (`tsc --noEmit`)
