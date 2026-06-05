---
name: graph-enginerring-design-verification
description: Graph-Native Runtime ADR verification status, key decisions, and harness config (repo: ClydeShen/graph-engineering)
metadata: 
  node_type: memory
  type: project
  originSessionId: 68673a45-8a9b-4626-8b55-154437e3b568
---

Design verification complete across 2 grill sessions. 23 ADRs locked (including 2 supplements). Ready for Phase 1 planning.

**Why:** All P0 blockers resolved, architecture stress-tested.

**How to apply:** Next session goal is writing arch docs + tech stack listing, then `/gsd-plan-phase 1`.

## Critical Findings (Session 1, 2026-05-31)

**ADR 02 — jsonb::text REFUTED**
`canonical_json()` MUST be done at app layer via BTreeMap recursion. PostgreSQL receives pre-normalized TEXT, never `::jsonb` cast before hashing. Two-phase contract: canonicalization in app layer (once, immutable); hash recompute locked in PG transaction kernel.

**tokio-postgres:** `Connection::poll_message()` + `stream::poll_fn`, NOT `Client::notifications()` (does not exist).

**P0-A/B/C resolved:** tsvector BM25, RRF k=60, mem::reflect centralized in iii-engine.

## Key Grill Session Decisions (Session 2, 2026-05-31)

- **CJK tsvector**: `simple` config invalid for Chinese BM25; Phase 1 accepts degradation to vector-only; Phase 3+ zhparser
- **mem::reflect interface**: Worker passes `query_text` only; iii-engine generates embedding via EmbeddingProvider (ADR 22)
- **ADR 22 (LLM/Embedding Provider abstraction)**: OpenAI-compatible API covers ollama/llama.cpp/mlx/lmstudio; minimize LLM calls principle; all unavoidable LLM calls explicitly documented
- **ADR 13 supplement (Context OOM)**: three-tier chain — N_root distillation (LLM) → N_current tail truncation → `context_oom_throttled` control-plane direct write; Scope enters Suspended state
- **ADR 23 (Nested Scope)**: Phase 1 forward-compat only (`spawn_sub_scope:true` silently ignored); Phase 3 full mechanism: `scope_lineage` table + `sub_scope_resolved` signal + SubScopeResultWorker
- **TemplateProposalWorker**: pre-filter `task_count≥5 AND unique_worker_types≥2`; four-signal score adds `diversity×0.15` (normalized `unique_worker_types`)
- **ADR 19 SQL bug fixed**: `NOT IN` → `NOT EXISTS` (NULL in subquery caused false convergence detection)
- **`context_oom_throttled` + `sub_scope_resolved`**: both control-plane direct-write, not in 5-event enum (ADR 12 unchanged)

## ADR File Map
- ADR 01–21: `docs/ADR_v4.md`
- ADR 20 supplement (BM25/RRF): `docs/adr/0021-adr20-supplement-hybrid-retrieval-bm25-rrf.md`
- ADR 21 (reflection track): `docs/adr/0022-adr21-reflection-track-trigger-spec.md`
- ADR 22 (LLM provider): `docs/adr/0023-adr22-llm-provider-abstraction.md`
- ADR 13 supplement (OOM): `docs/adr/0024-adr13-supplement-context-oom-degradation.md`
- ADR 23 (nested scope): `docs/adr/0025-adr23-nested-scope-propagation.md`

## Open Items
- Phase 2: `memory::write_guard` (P1-E), Working Memory dedup window (P1-F), cron triggers (P2-D/E)
- Phase 3: zhparser CJK, nested Scope full implementation, relative efficiency baseline
- Phase 4: Pi Sandbox (P1-B)
- Pi spawn needs `{shell:true}` on all platforms (STATE.md risk #9)
- iii Windows: Docker or WSL2 dev path (STATE.md risk #10)

## Harness Setup (2026-06-01)

- **Correct repo slug:** `ClydeShen/graph-engineering` (not `graph-enginerring` — typo fixed in config.json)
- **GitHub Projects v2 board:** #4 — https://github.com/users/ClydeShen/projects/4
- **Milestones:** Design (#1), MVP (#2), v1.0 (#3)
- **Labels:** 9 canonical `status:*` labels created
- **project_fields** IDs written to `.harness/config.json` (status, effort, size field IDs + option maps)

[[state-json-design]]
