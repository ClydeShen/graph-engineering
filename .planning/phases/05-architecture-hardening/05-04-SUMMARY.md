---
phase: 05-architecture-hardening
plan: "04"
subsystem: shared/config
tags: [config, zod, env-interpolation, null-safe]
dependency_graph:
  requires: []
  provides: [loadMemexConfig, MemexConfigSchema, MemexConfig]
  affects: [packages/shared/src/index.ts]
tech_stack:
  added: []
  patterns: [zod-schema-inference, env-var-interpolation, null-on-failure]
key_files:
  created:
    - packages/shared/src/config/loader.ts
    - packages/shared/src/config/loader.test.ts
  modified:
    - packages/shared/src/index.ts
decisions:
  - "No new npm packages — uses zod (existing in shared) and Node built-ins (node:fs, node:os, node:path)"
  - "resolveEnvVars() runs on the raw JSON string before JSON.parse so substituted values are valid JSON"
  - "DEFAULT_CONFIG_PATH = join(homedir(), .memex, config.json) mirrors Pi SDK .pi pattern"
  - "Tests use real tmpdir temp files (not vi.mock for fs) — matches plan directive"
  - "All top-level config fields are optional — Gateway always falls back to env vars"
metrics:
  duration_minutes: 3
  completed_date: "2026-06-09T11:22:00Z"
  tasks_completed: 2
  files_changed: 3
---

# Phase 05 Plan 04: Memex Config Loader Summary

**One-liner:** Null-safe ~/.memex/config.json loader with Zod validation and ${ENV_VAR} interpolation before JSON.parse, exported from @graph/shared barrel.

## What Was Built

### Task 1: loadMemexConfig() with Zod schema and env interpolation (TDD)

Created `packages/shared/src/config/loader.ts`:

- `DEFAULT_CONFIG_PATH` constant — `join(homedir(), '.memex', 'config.json')`
- `ProviderEntrySchema` — Zod schema for individual provider entries (name, type, apiKey, baseUrl, model, priority)
- `MemexConfigSchema` — exported Zod schema; all top-level fields optional (gateway, providers, channels)
- `MemexConfig` type — inferred from `MemexConfigSchema`
- `resolveEnvVars(raw: string): string` — private helper; replaces `${VAR}` with `process.env[VAR] ?? ''` on raw string before JSON.parse
- `loadMemexConfig(configPath?)` — returns `MemexConfig | null`; null on missing file, malformed JSON, or Zod validation failure

**TDD gate compliance:**
- RED commit `5badc7d`: 7 test cases; tests failed (loader.ts absent)
- GREEN commit `fa0d82df`: implementation; all 7 tests pass

**Key behaviors verified:**
- Missing file → null (no throw)
- Malformed JSON → null (no throw)
- Valid config → parsed MemexConfig object
- `${TEST_MEMEX_KEY}` in string value → substituted from process.env before parse
- Unresolved var → empty string `''`
- Zod failure (port is string) → null
- Type assertions: gateway.port is number, providers is array, channels is object

### Task 2: Export from @graph/shared barrel

Added one line to `packages/shared/src/index.ts` after `export * from './notify.js'`:

```typescript
export * from './config/loader.js';
```

tsc --noEmit exits 0; no name conflicts with existing barrel exports.

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

None — loadMemexConfig() is fully functional; no placeholder values.

## Threat Surface Scan

No new network endpoints, auth paths, or trust boundary changes introduced.
The config file path is user-owned (`~/.memex/config.json`); env var interpolation does not expand values into code execution paths (only into string fields parsed by Zod).

## Self-Check: PASSED

- [x] `packages/shared/src/config/loader.ts` exists
- [x] `packages/shared/src/config/loader.test.ts` exists
- [x] `packages/shared/src/index.ts` contains `config/loader`
- [x] RED commit `5badc7d` exists in git log
- [x] GREEN commit `fa0d82df` exists in git log
- [x] Barrel commit `7a7a526f` exists in git log
- [x] All 7 loader tests pass
- [x] tsc --noEmit exits 0
