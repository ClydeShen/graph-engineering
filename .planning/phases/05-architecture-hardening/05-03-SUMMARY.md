---
phase: 05-architecture-hardening
plan: 03
subsystem: types
tags: [types, architecture, leaf-package, refactor]
dependency_graph:
  requires: []
  provides: ["@graph/types leaf package", "@graph/types/core", "@graph/types/api", "@graph/types/shell"]
  affects: ["packages/shared", "packages/types"]
tech_stack:
  added: ["@graph/types package"]
  patterns: ["leaf package pattern", "re-export shim", "sub-path exports"]
key_files:
  created:
    - packages/types/package.json
    - packages/types/src/core.ts
    - packages/types/src/api.ts
    - packages/types/src/shell.ts
    - packages/types/src/index.ts
    - packages/types/tsconfig.json
  modified:
    - packages/shared/src/types.ts
    - packages/shared/package.json
    - tsconfig.json
decisions:
  - CanonicalEventType inlined in @graph/types/api as controlled duplicate (cannot import from @graph/shared without circular dep; identical to EVENT_TYPES in constants.ts; tracked as known drift)
  - tsconfig.json path aliases added for @graph/types, @graph/types/core, @graph/types/api, @graph/types/shell to enable tsc resolution
  - packages/shared/src/types.ts uses named type re-exports (export type { ... }) not export * to avoid re-exporting non-type members
metrics:
  duration_min: 10
  completed: "2026-06-09"
  tasks_completed: 2
  files_changed: 9
---

# Phase 05 Plan 03: @graph/types Leaf Package Summary

**One-liner:** New `@graph/types` leaf package with core/api/shell sub-paths; `packages/shared/src/types.ts` converted to a re-export shim preserving all existing import paths.

## What Was Built

### Task 1: Create @graph/types package scaffold and sub-modules (commit: 0ab4485d)

Created a new `packages/types/` workspace package with zero `@graph/*` dependencies:

- `package.json`: name `@graph/types`, four named exports (`.`, `./core`, `./api`, `./shell`), only `@earendil-works/pi-coding-agent` dependency — no `@graph/*` deps
- `src/core.ts`: Memex vocabulary types — `Entity`, `Snapshot`, `HyperEdge`, `Scope`, `Trail`
- `src/api.ts`: HTTP/MCP wire types — `CanonicalEventType` (inlined union), `EventLogNode`, `GraphWriteEvent`, `WriteResult`
- `src/shell.ts`: MemexTerminal SSE type — `TrailSseEvent`
- `src/index.ts`: barrel re-export of all three sub-modules
- `tsconfig.json`: extends root config, compiles with 0 errors

Root `tsconfig.json` path aliases added:
- `@graph/types` → `packages/types/src/index.ts`
- `@graph/types/core` → `packages/types/src/core.ts`
- `@graph/types/api` → `packages/types/src/api.ts`
- `@graph/types/shell` → `packages/types/src/shell.ts`

### Task 2: Convert packages/shared/src/types.ts to re-export shim (commit: 2f17e296)

- `packages/shared/src/types.ts`: replaced 55-line type file with a 3-line re-export shim pointing to `@graph/types/api`; uses named `export type { ... }` to preserve exact symbol names
- `packages/shared/package.json`: added `"@graph/types": "*"` to dependencies

All existing callers (`occ-write.ts`, `index.ts`, etc.) continue to resolve types from `./types.js` unchanged — the shim is backward-compatible.

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

```
npx tsc --noEmit -p packages/types/tsconfig.json  → exit 0 (0 errors)
npx tsc --noEmit (root)                            → exit 0 (0 errors, covers packages/shared)
grep "@graph/" packages/types/package.json          → only "name": "@graph/types" (no @graph/* deps)
```

All success criteria met:
- `packages/types/` exists as standalone package with `package.json`
- `@graph/types` has zero `@graph/*` dependencies
- `@graph/types` exports `core`/`api`/`shell` sub-paths
- `packages/shared/src/types.ts` is a re-export shim (no type definitions remain in it)
- All existing callers continue to compile without changes

## Known Stubs

None.

## Threat Flags

| Flag | File | Description |
|------|------|-------------|
| threat_flag: controlled-duplicate | packages/types/src/api.ts | CanonicalEventType inlined union — intentional design to preserve leaf constraint; identical to EVENT_TYPES in shared/constants.ts; tracked in implementation-notes.md |

## Self-Check: PASSED

Files exist:
- packages/types/package.json: FOUND
- packages/types/src/core.ts: FOUND
- packages/types/src/api.ts: FOUND
- packages/types/src/shell.ts: FOUND
- packages/types/src/index.ts: FOUND
- packages/types/tsconfig.json: FOUND
- packages/shared/src/types.ts (modified): FOUND

Commits exist:
- 0ab4485d: FOUND (feat(05-03): create @graph/types leaf package)
- 2f17e296: FOUND (refactor(05-03): convert packages/shared/src/types.ts to re-export shim)
