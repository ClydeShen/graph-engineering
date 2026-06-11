---
phase: 01-core-graph-engine
plan: "03"
subsystem: occ-write
tags: [postgresql, pgcrypto, occ, writable-cte, causal-inversion, idempotency, integration-tests]
dependency_graph:
  requires: [01-01, 01-02]
  provides: [OCC_WRITE_SQL, OCC_WRITE_DO_NOTHING_SQL, occWrite, occWriteIdempotent]
  affects: [01-04, 01-05, 01-06, 01-07, 01-08, 01-09, 01-10]
tech_stack:
  added: []
  patterns: [writable-cte, pgcrypto-sha256, column-list-on-conflict, causal-inversion, do-nothing-idempotency]
key_files:
  created:
    - packages/shared/src/sql/occ-writable-cte.sql.ts
    - packages/shared/src/occ-write.ts
    - tests/integration/hash-chain.test.ts
    - tests/integration/occ.test.ts
    - tests/integration/idempotency.test.ts
  modified:
    - packages/shared/src/index.ts
decisions:
  - "Column-list ON CONFLICT (predecessor_hash, scope_id) — not constraint-name form — resolves correctly across partitions without requiring per-partition constraint name (Pitfall 5)"
  - "Application sends canonical_json_text as TEXT only; pgcrypto digest() inside CTE computes version_hash atomically — no crypto.createHash() in application layer (ADR 02)"
  - "occWriteIdempotent returns null on no-op insert, not an error — at-least-once re-delivery is transparent by design (ADR 32 D-5, ADR 36 D-9)"
  - "Test partition constraints named with test-specific prefixes (uk_occ_hc_, uk_occ_occ_, uk_occ_id_) to avoid collision when multiple test suites share a DB"
metrics:
  duration: "6 minutes"
  completed: "2026-06-03"
  tasks_completed: 3
  files_created: 5
  files_modified: 1
  tests_written: 7
requirements_covered: [REQ-02, REQ-18]
---

# Phase 1 Plan 03: OCC Writable CTE Summary

pgcrypto Writable CTE implementing first-writer-wins OCC with atomic causal inversion and ON CONFLICT DO NOTHING idempotency — application sends pre-serialized TEXT, DB computes SHA-256 version_hash inside a single transaction.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | OCC Writable CTE SQL template (REQ-02) | `f6dbd33` | packages/shared/src/sql/occ-writable-cte.sql.ts |
| 2 | occWrite() TypeScript helper | `11a0382` | packages/shared/src/occ-write.ts, packages/shared/src/index.ts |
| 3 | OCC + hash-chain + idempotency integration tests | `11d6a0d` | tests/integration/hash-chain.test.ts, tests/integration/occ.test.ts, tests/integration/idempotency.test.ts |

## Verification Results

- `npx tsc --noEmit` exits 0 (strict TypeScript, all files type-safe)
- `npm run test:integration -- occ idempotency hash-chain` exits 0 (7 tests skipped cleanly without DATABASE_URL)
- SQL file contains `ON CONFLICT (predecessor_hash, scope_id)` (column-list form, NOT constraint-name form)
- SQL file contains `digest(` and `encode(` and literal `|memory_updated|` and `|conflict_detected|` hash inputs
- SQL file stores `payload = $4::text` — no `::jsonb` in any SQL code path

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Worktree missing Plan 01/02 source files**
- **Found during:** Pre-task setup
- **Issue:** The worktree branch (`worktree-agent-a0078f3e6433659ae`) was at commit `eee7384` (pre-planning), not at the wave 1-2 base `69473ea`. Files from Plan 01 (`packages/shared/src/`, `tsconfig.json`, etc.) and Plan 02 (`migrations/`) were absent from the worktree working directory.
- **Fix:** Used `git checkout 69473ea -- packages/ migrations/ tests/ ...` to restore all Plan 01/02 files into the worktree, then committed as a foundation chore commit (`f90370e`) before proceeding with Plan 03 implementation.
- **Files modified:** 18 files (all Plan 01/02 outputs)
- **Commit:** `f90370e`

## Known Stubs

None. All exported functions are fully implemented. Integration tests skip cleanly without DB but are ready to execute when DATABASE_URL is provided.

## Threat Flags

None. This plan creates no network endpoints, auth paths, or file access patterns. The OCC CTE is a write path to PostgreSQL, which was already scoped in the threat model.

## Self-Check: PASSED

Files checked:
- FOUND: packages/shared/src/sql/occ-writable-cte.sql.ts
- FOUND: packages/shared/src/occ-write.ts
- FOUND: tests/integration/hash-chain.test.ts
- FOUND: tests/integration/occ.test.ts
- FOUND: tests/integration/idempotency.test.ts

Commits verified:
- FOUND: f6dbd33 (Task 1 — OCC SQL template)
- FOUND: 11a0382 (Task 2 — occWrite helper)
- FOUND: 11d6a0d (Task 3 — integration tests)
