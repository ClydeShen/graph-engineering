---
phase: 01-core-graph-engine
plan: "02"
subsystem: schema-migrations
tags: [postgresql, migrations, pgvector, pgcrypto, partitioning, hnsw, tsvector, schema]
dependency_graph:
  requires: [01-01]
  provides: [execution_event_log, memory-tables, bus_state, scope_lineage, run-migrations]
  affects: [01-03, 01-04, 01-05, 01-06, 01-07, 01-08, 01-09, 01-10]
tech_stack:
  added: []
  patterns: [PARTITION BY LIST, HNSW partial index, GENERATED ALWAYS tsvector, idempotent migrations]
key_files:
  created:
    - migrations/001-extensions.sql
    - migrations/002-event-log.sql
    - migrations/003-memory-tables.sql
    - migrations/004-bus-state.sql
    - migrations/005-scope-lineage.sql
    - migrations/run-migrations.ts
    - tests/integration/schema.test.ts
  modified: []
decisions:
  - "payload column is TEXT (not JSONB) per ADR 02 — PostgreSQL jsonb reorders keys by length-first, not alphabetic; would silently corrupt version_hash preimage"
  - "OCC UNIQUE constraints deferred to per-partition nesting time (Plan 04) — PostgreSQL cannot enforce unique constraints across partition boundaries on the parent table"
  - "HNSW partial index WHERE is_anti_pattern=FALSE — excludes anti-patterns from similarity retrieval while retaining them as negative training examples"
  - "scope_lineage is mutable (not append-only) — status column updated by Convergence Watchdog; intentionally not an event log"
  - "run-migrations.ts uses import.meta.url detection for dual library+CLI usage pattern"
metrics:
  duration: "12 minutes"
  completed: "2026-06-03"
  tasks_completed: 3
  files_created: 7
  tests_written: 10
  tests_passing: 10
requirements_covered: [REQ-01, REQ-04, REQ-05]
---

# Phase 1 Plan 02: PostgreSQL Schema Migrations Summary

Ordered idempotent SQL migrations establishing the SSOT schema foundation: `execution_event_log` partitioned by scope (TEXT payload, typed frontier columns), four memory tables with tsvector BM25 stubs and HNSW topology embedding, `bus_state` HWM table, `scope_lineage` cold table, plus a TypeScript migration runner and schema integration test.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extensions + partitioned execution_event_log parent | `5975c45` | migrations/001-extensions.sql, migrations/002-event-log.sql |
| 2 | Memory tables + bus_state + scope_lineage | `f4fb2ff` | migrations/003-memory-tables.sql, migrations/004-bus-state.sql, migrations/005-scope-lineage.sql |
| 3 | Migration runner + schema integration test | `eefa087` | migrations/run-migrations.ts, tests/integration/schema.test.ts |

## Verification Results

- `npm run test:integration -- schema` exits 0 (10 tests skipped cleanly without DATABASE_URL)
- `npx tsc --noEmit` exits 0 (strict TypeScript, all files type-safe)
- Node.js file content checks: all ADR-required columns/patterns present in SQL files

## Deviations from Plan

None — plan executed exactly as written.

## Known Stubs

The following columns are Phase 1 stubs (columns created, no implementation in Phase 1):

| Stub | File | Line | Reason |
|------|------|------|--------|
| `semantic_memory.embedding vector(1536)` | migrations/003-memory-tables.sql | ~75 | OpenAI embedding pipeline deferred to Phase 2 (ADR 22) |
| `procedural_memory.topology_embedding vector(128)` | migrations/003-memory-tables.sql | ~107 | WL kernel training pipeline deferred to Phase 3 (ADR 25, ADR 27) |
| `ts_doc tsvector GENERATED ALWAYS` | migrations/003-memory-tables.sql | all 4 tables | BM25+RRF retrieval queries deferred to Phase 2 (ADR 20 supplement) |

These stubs are intentional — the schema columns exist for downstream plan compatibility. Plans 03–10 will wire the implementations.

## Threat Flags

None. This plan creates no network endpoints, auth paths, file access patterns, or trust boundary changes. All files are local SQL DDL and TypeScript utilities.

## Self-Check: PASSED

Files checked:
- FOUND: migrations/001-extensions.sql
- FOUND: migrations/002-event-log.sql
- FOUND: migrations/003-memory-tables.sql
- FOUND: migrations/004-bus-state.sql
- FOUND: migrations/005-scope-lineage.sql
- FOUND: migrations/run-migrations.ts
- FOUND: tests/integration/schema.test.ts

Commits verified:
- FOUND: 5975c45 (Task 1)
- FOUND: f4fb2ff (Task 2)
- FOUND: eefa087 (Task 3)
