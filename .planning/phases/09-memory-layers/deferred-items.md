# Deferred Items — Phase 09 Plan 03 execution

## Pre-existing TypeScript errors in template-proposal.worker.test.ts

**Source:** Brought in by merge of Plan 02 (`worktree-agent-a3868c4f25f2f7073`).
**Errors:**
- `Type '"graph::scope::opened"' is not assignable to type 'CanonicalEventType'`
- `Type '"graph::scope::closed"' is not assignable to type 'CanonicalEventType'`
- Overload resolution error in `find()` predicate

**Cause:** `template-proposal.worker.test.ts` uses string literals for event types that
aren't in `CanonicalEventType`. This was a pre-existing condition in Plan 02's commit.

**Action needed:** Fix `template-proposal.worker.test.ts` to use correct `CanonicalEventType`
values, or add the missing event types to the type definition.

**Out of scope for Plan 03.** Plan 03 only modifies `semantic.worker.ts` and its test file.
