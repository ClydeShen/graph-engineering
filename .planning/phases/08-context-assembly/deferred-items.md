# Deferred Items — Phase 08 Context Assembly

## Pre-existing test failures unrelated to Plan 02

**Found during:** Plan 02, Task 1 (PipelineContext + pipeline hooks on Worker)

**Issue:** `npx vitest run` for `packages/workers` shows 8 failed test files with:
```
Error: Failed to load url @graph/types/api (resolved id: @graph/types/api) in
D:/Repo/graph-enginerring/.claude/worktrees/agent-a82bba812cd59e8b9/packages/shared/src/types.ts.
Does the file exist?
```

Affected files: `crystallize.worker.test.ts`, `gate3.integration.test.ts`,
`semantic.worker.test.ts`, `synthesizer.worker.test.ts`,
`sub-scope-result.worker.test.ts`, `gate4.integration.test.ts`,
`frontier.test.ts`, `lesson-save.worker.test.ts`.

**Scope:** Out of scope for Plan 02 — these failures are a module-resolution
issue in `packages/shared/src/types.ts` (`@graph/types/api` import), not
caused by the `worker.abstract.ts` changes in this plan. Plan 02's target
test (`src/base/worker.abstract.test.ts`) passes 4/4, and `npx tsc --noEmit`
for `packages/workers` is clean.

**Action:** Not fixed. Logged for awareness — may already be tracked/fixed by
another concurrent Phase 08 wave plan or a prior phase issue.
