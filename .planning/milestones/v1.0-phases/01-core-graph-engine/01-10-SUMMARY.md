---
phase: 01-core-graph-engine
plan: "10"
subsystem: pattern-discovery
tags: [cron, pattern-discovery, min-corpus, worker]
dependency_graph:
  requires: [01-05]
  provides: [PatternDiscoveryWorker, PATTERN_DISCOVERY_CRON_TRIGGER]
  affects: [01-09]
tech_stack:
  - TypeScript
  - iii-sdk (cron trigger)
  - pg (Pool)
requirements_covered: [REQ-22]
status: complete
---

## Summary

Implemented the Pattern Discovery cron stub Worker: `graph::patterns::discover`.

## Files created

| File | Purpose |
|------|---------|
| `packages/workers/src/patterns/discover.worker.ts` | PatternDiscoveryWorker class + PATTERN_DISCOVERY_CRON_TRIGGER |
| `src/__tests__/pattern-discovery.test.ts` | 4 unit tests covering guard + base_priority + cron config |

## Key decisions

- **Registration deferred to Plan 09**: `PATTERN_DISCOVERY_CRON_TRIGGER` exported as config constant; `registerTrigger` called only in Plan 09 `index.ts` boot entry to prevent double-registration.
- **Cold-start guard**: `completed_scope_count < MIN_CORPUS_THRESHOLD (10)` → `{ skipped: true }`. Full WL-kernel extraction is Phase 3.
- **No OLTP slot consumption**: worker runs on cron budget only, not the 4 OLTP queue slots.
- **No scope_completed subscription**: cron-only trigger, never inline.

## Verification

- `node_modules/.bin/tsc --noEmit` → exit 0
- `npm run test:unit -- pattern-discovery` → 4/4 pass (36 total)
