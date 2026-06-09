---
phase: 01-core-graph-engine
plan: "01"
subsystem: scaffold
tags: [typescript, monorepo, vitest, canonical-json, shared-package, tooling]
dependency_graph:
  requires: []
  provides: [packages/shared, canonical-json, hashablePayload, shared-types, zod-schemas, constants, vitest-config, pg-test-pool]
  affects: [all-downstream-plans]
tech_stack:
  added: [iii-sdk@0.17.0, pg@8.21.0, pg-listen@1.7.0, hono@4.12.23, zod@4.4.3, "@dqbd/tiktoken@1.0.22", "@hono/zod-validator@0.8.0", vite-tsconfig-paths@6.1.1, vitest@2.x, tsx@4.22.4]
  patterns: [npm-workspaces, strict-typescript, tdd-red-green, bTreeMap-canonical-sort]
key_files:
  created:
    - packages/shared/src/canonical-json.ts
    - packages/shared/src/constants.ts
    - packages/shared/src/types.ts
    - packages/shared/src/schemas.ts
    - packages/shared/src/index.ts
    - packages/shared/package.json
    - package.json
    - tsconfig.json
    - vitest.config.mts
    - iii-config.yaml
    - src/__tests__/canonical-json.test.ts
    - tests/helpers/pg-test-pool.ts
  modified: []
decisions:
  - "vitest.config.mts instead of .ts — vite-tsconfig-paths is ESM-only; .mts file enables ESM import syntax in vitest config"
  - "vite-tsconfig-paths added as devDependency — required for @shared/* alias resolution in Vitest 2.x on Windows"
  - "z.record(z.string(), z.unknown()) instead of z.record(z.unknown()) — Zod 4.4.3 type definitions require explicit key schema"
metrics:
  duration: "13 minutes"
  completed: "2026-06-02"
  tasks_completed: 3
  files_created: 12
  tests_written: 8
  tests_passing: 8
requirements_covered: [REQ-03]
---

# Phase 1 Plan 01: Workspace Scaffold, Tooling, and canonicalJson Summary

TypeScript monorepo scaffold with strict tooling, vitest configuration, iii-config.yaml, and the `@graph/shared` package providing `canonicalJson`/`hashablePayload` BTreeMap-equivalent serialization plus shared types, constants, and Zod schemas.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Workspace scaffold + tooling | `6c3e903` | package.json, tsconfig.json, vitest.config.mts, packages/shared/package.json, iii-config.yaml |
| 2 | canonicalJson + shared types/constants/schemas (TDD) | RED: `b6375fc`, GREEN: `6099eb8` | canonical-json.ts, constants.ts, types.ts, schemas.ts, index.ts, canonical-json.test.ts |
| 3 | PG integration test helper stub | `de58af0` | tests/helpers/pg-test-pool.ts |

## Verification Results

- `npm run test:unit -- canonical-json` passes 8/8 tests
- `npx tsc --noEmit` exits 0 (strict mode, all files type-safe)
- `iii-config.yaml` contains all 5 worker blocks, OpenAI-compatible LLM + embedding provider, no shell variable injection

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] vitest.config.ts renamed to vitest.config.mts for ESM alias resolution**
- **Found during:** Task 2 RED phase
- **Issue:** `vite-tsconfig-paths@6.1.1` is ESM-only. Loading via `require()` in a `.ts` vitest config fails with: "resolved to an ESM file. ESM file cannot be loaded by require".
- **Fix:** Renamed to `vitest.config.mts`. The `.mts` extension forces ESM processing, allowing `import tsconfigPaths from 'vite-tsconfig-paths'` to work. `vite-tsconfig-paths` verified on npm registry before install.
- **Files modified:** `vitest.config.mts` (renamed from .ts), `package.json`, `package-lock.json`
- **Commits:** `b6375fc`

**2. [Rule 1 - Bug] tsconfig.json missing `baseUrl` for `paths` aliases**
- **Found during:** Task 1 verify
- **Issue:** TypeScript error TS5090: "Non-relative paths are not allowed when 'baseUrl' is not set."
- **Fix:** Added `"baseUrl": "."` to compilerOptions.
- **Files modified:** `tsconfig.json`
- **Commit:** `6c3e903`

**3. [Rule 1 - Bug] Zod 4.4.3 `z.record()` requires two type arguments**
- **Found during:** Task 2 tsc verification
- **Issue:** TypeScript error TS2554: "Expected 2-3 arguments, but got 1." Zod 4.x type definitions require explicit key schema.
- **Fix:** Changed `z.record(z.unknown())` to `z.record(z.string(), z.unknown())`.
- **Files modified:** `packages/shared/src/schemas.ts`
- **Commit:** `6099eb8`

## TDD Gate Compliance

| Gate | Commit | Status |
|------|--------|--------|
| RED (test) | `b6375fc` | Tests correctly failed — module not found before implementation |
| GREEN (feat) | `6099eb8` | All 8 tests passed after implementation |
| REFACTOR | (inline with GREEN) | Minor comment cleanup in canonical-json.ts |

## Known Stubs

None. All exports are fully implemented and tested.

## Threat Flags

None. This plan creates no network endpoints, auth paths, file access patterns, or schema changes.

## Self-Check: PASSED
