---
phase: 05-architecture-hardening
plan: 05
subsystem: gateway
tags: [skills-route, two-phase-loading, mtime-cache, path-traversal, security]
dependency_graph:
  requires: ['05-02']
  provides: ['GET /v1/skills', 'GET /v1/skills/:id']
  affects: ['packages/gateway/src/index.ts']
tech_stack:
  added: []
  patterns: ['two-phase frontmatter loading', 'mtime-based cache invalidation', 'SHA-256 hex id validation']
key_files:
  created:
    - packages/gateway/src/routes/skills.ts
    - packages/gateway/src/routes/skills.test.ts
  modified:
    - packages/gateway/src/index.ts
    - tsconfig.json
decisions:
  - "mtime cache uses <= for cache-hit check (invalidate when mtimeMs strictly increases) per Windows 100ms resolution constraint"
  - "id regex /^[0-9a-f]{64}$/ enforces SHA-256 hex format as path traversal prevention (T-05-05-01)"
  - "per-instance cache closures in buildSkillsRoute() — each call creates independent cachedList/cachedMtime for test isolation"
  - "Rule 3 fix: added @graph/types/* path mappings to tsconfig.json to resolve pre-existing tsc error from plan 05-03 types migration"
metrics:
  duration_min: 9
  completed_date: "2026-06-09"
  tasks_completed: 2
  files_changed: 4
---

# Phase 05 Plan 05: Skills Route Summary

Two-phase agentskills.io skill reader endpoints for the HTTP Gateway: `GET /v1/skills` returns skill summaries (name + description, no body), `GET /v1/skills/:id` returns full SKILL.md content on demand.

## What Was Built

### Task 1: buildSkillsRoute with two-phase loading and mtime cache

Created `packages/gateway/src/routes/skills.ts`:

- `GET /v1/skills` scans `skillsDir` for subdirectory/SKILL.md files, parses frontmatter-only (name, description, fingerprint_id), returns `{ skills: [{ fingerprintId, name, description }] }`. Full body text is never included in list response.
- `GET /v1/skills/:id` reads `skillsDir/{id}/SKILL.md` and returns `{ content: '<full SKILL.md>' }` or 404.
- Module-level mtime cache per route instance: rebuilds list only when `dirStat.mtimeMs > cachedMtime` (strictly greater-than to handle Windows 100ms filesystem resolution).
- Path traversal prevention: `:id` validated against `/^[0-9a-f]{64}$/` before any path construction — returns 400 if invalid (T-05-05-01).
- No database dependency — reads filesystem only.
- 12 vitest tests covering: empty directory, missing directory, list shape, body exclusion, full content retrieval, 404, 400 (path traversal/invalid format), cache stability, cache invalidation on mtime change.

### Task 2: Mount buildSkillsRoute in gateway

Added `import { buildSkillsRoute } from './routes/skills.js'` and `app.route('/v1', buildSkillsRoute())` to `packages/gateway/src/index.ts`. buildSkillsRoute takes no pool argument — filesystem only with SKILLS_DIR env var default.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Missing @graph/types path mappings in worktree tsconfig.json**
- **Found during:** Task 2 tsc verification
- **Issue:** `tsc --noEmit` failed with `Cannot find module '@graph/types/api'` because the main repo's `node_modules/@graph/shared/src/types.ts` was modified by plan 05-03 to be a re-export shim from `@graph/types/api`. The worktree's tsconfig had no `@graph/types/*` path mappings, causing transitive resolution failures.
- **Fix:** Added `@graph/types`, `@graph/types/core`, `@graph/types/api`, `@graph/types/shell` path mappings to `tsconfig.json` pointing to `../../../packages/types/src/` (main repo's already-built types package).
- **Files modified:** `tsconfig.json`
- **Commit:** e405760c
- **Note:** Pre-existing error — not caused by this plan's changes. The worktree predates plan 05-03's @graph/types creation.

**2. [Rule 1 - Test adjustment] URL normalization with path traversal test**
- **Found during:** Task 1 test execution
- **Issue:** Test using `http://localhost/skills/../../etc/passwd` resulted in 404 (not 400) because the URL constructor normalizes `../../etc/passwd` to `/etc/passwd` before Hono routing, so the request never reached `/skills/:id`.
- **Fix:** Changed test to use `.` chars in a 64-char id (not URL path traversal) to test the regex validation directly.
- **Files modified:** `packages/gateway/src/routes/skills.test.ts`

**3. [Rule 1 - Test adjustment] vi.spyOn(fs, 'readdirSync') non-configurable property**
- **Found during:** Task 1 test execution (mtime cache tests)
- **Issue:** `vi.spyOn(fs, 'readdirSync')` threw `Cannot redefine property: readdirSync` because Node's `fs` module properties are non-configurable in ESM.
- **Fix:** Replaced spy-count assertions with behavioral assertions: (a) stable cache returns same results on repeated calls, (b) cache invalidation tested by using `fs.utimesSync` to advance directory mtime then verifying the list count increases.
- **Files modified:** `packages/gateway/src/routes/skills.test.ts`

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| T-05-05-01 mitigated | packages/gateway/src/routes/skills.ts | :id validated as /^[0-9a-f]{64}$/ before path construction — path traversal prevented |
| T-05-05-02 accepted | packages/gateway/src/routes/skills.ts | SKILL.md content forwarded verbatim; no external secrets in internally-written skill files |
| T-05-05-03 accepted | packages/gateway/src/routes/skills.ts | readdirSync is sync; <1000 skills; mtime cache limits scan frequency |

## Self-Check: PASSED

- [x] `packages/gateway/src/routes/skills.ts` exists
- [x] `packages/gateway/src/routes/skills.test.ts` exists
- [x] `packages/gateway/src/index.ts` contains `buildSkillsRoute`
- [x] `tsconfig.json` contains `@graph/types/api` path mapping
- [x] Commit 67ac62bf exists (Task 1)
- [x] Commit e405760c exists (Task 2)
- [x] `npx vitest run packages/gateway/src/routes/skills.test.ts` — 12/12 passed
- [x] `npx tsc --noEmit` — exits 0
