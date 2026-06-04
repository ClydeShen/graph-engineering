---
plan: 02-01
status: complete
commit: a13a4c7
---

## Migration 006 — Phase 2 schema extensions

Created `migrations/006-memory-extensions.sql`. Idempotent (all `IF NOT EXISTS`).

### Changes per table

| Table | Added |
|---|---|
| `episodic_memory` | `entity_id UUID`, `intent_summary TEXT`, `outcome_summary TEXT` |
| `semantic_memory` | `superseded_by UUID`, HNSW index on `embedding` (m=16, ef=64, partial WHERE NOT NULL) |
| `procedural_memory` | `success_count INT DEFAULT 0`, `failure_count INT DEFAULT 0`, `reinforcement_count INT DEFAULT 0`, `last_used_at TIMESTAMPTZ DEFAULT NOW()`, `superseded_by UUID` |
| `working_memory` | `dedup_hash TEXT`, partial unique index `idx_working_memory_dedup ON (scope_id, dedup_hash) WHERE dedup_hash IS NOT NULL` |

### Decisions

- ts_doc dictionary kept as `english` (changing GENERATED ALWAYS requires DROP+ADD; accepted tradeoff documented in migration header)
- All Phase 2 BM25 queries use `plainto_tsquery('english', ...)` to match stored tsvector
- `quality_score` and `is_anti_pattern` from migration 003 NOT re-added
