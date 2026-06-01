# Architecture Backlog — Local Plan Mirror

> Source: `docs/未决问题追踪.md` (last updated 2026-06-01, Pre-Phase-1 comparative audit complete)
> GitHub milestone: [Architecture Backlog](https://github.com/ClydeShen/graph-engineering/milestone/4)
> All 13 issues: #1–#13

---

## Task 1: ADR 20 supplement — reinforcement SQL on template adoption

**Type:** docs
**Effort:** 1 context window (~150K–200K tokens)

### What to build
Add the reinforcement SQL block (`UPDATE procedural_memory SET success_count = success_count + 1, last_used_at = NOW()`) to ADR 20 operational patterns section.

### Acceptance criteria
- [ ] ADR 20 contains reinforcement SQL under an "Operational Patterns" section
- [ ] SQL matches: `UPDATE procedural_memory SET success_count = success_count + 1, last_used_at = NOW() WHERE id = $matched_template_id`
- [ ] Unknown template id results in zero-row UPDATE (no error)

### Files likely involved
<!-- agent decides -->

---

## Task 2: ADR 20 supplement — Memory Synthesizer dual-trigger strategy

**Type:** docs
**Effort:** 1 context window

### What to build
Document the dual-trigger strategy in ADR 20 §Memory Synthesizer: primary iii-cron daily 2 AM + optional event-driven trigger (scope_closed + ≥20 episodic records).

### Acceptance criteria
- [ ] ADR 20 §Memory Synthesizer contains primary trigger `expression: '0 0 2 * * * *'`
- [ ] ADR 20 contains optional supplemental trigger: scope_closed + episodic_count ≥ 20
- [ ] Supplemental trigger does NOT fire below threshold

### Files likely involved
<!-- agent decides -->

---

## Task 3: Ops spec — iii-cron Ebbinghaus decay scan schedule

**Type:** docs
**Effort:** 1 context window

### What to build
Write the Ebbinghaus decay scan schedule into the operations spec and iii-config.yaml: daily 3 AM, threshold `reinforcement_count = 0 AND last_used_at < NOW() - INTERVAL '90 days'`, logical delete via `superseded_by = id`.

### Acceptance criteria
- [ ] Ops spec contains schedule `expression: '0 0 3 * * * *'`
- [ ] Decay criteria documented: reinforcement_count = 0 AND last_used_at < 90 days
- [ ] Operation is logical delete (superseded_by = id), not physical DELETE
- [ ] Decay and synthesis cron entries appear as distinct entries at different hours

### Files likely involved
<!-- agent decides -->

---

## Task 4: Privacy Filter (memory::write_guard) — ADR 05 supplement or new ADR

**Type:** feature
**Effort:** 2 context windows (~300K–400K tokens)

### What to build
Implement `memory::write_guard` as an iii-engine layer Function that strips secrets (API keys, AWS keys, PG conn strings, `<secret>` tags) from payloads before memory writes, using pure regex.

### Acceptance criteria
- [ ] `sk-[A-Za-z0-9]{32,}` matched → replaced with `[REDACTED:api_key]`
- [ ] AWS access key pattern matched → `[REDACTED:aws_key]`
- [ ] PostgreSQL connection string matched → `[REDACTED:pg_conn]`
- [ ] `<secret>...</secret>` matched → `[REDACTED:secret_type]`
- [ ] Clean payload passes through unchanged
- [ ] Worker layer and PostgreSQL trigger layer do NOT duplicate this logic

### Files likely involved
<!-- agent decides -->

---

## Task 5: Working Memory SHA-256 dedup window — ADR 11 supplement

**Type:** feature
**Effort:** 2 context windows

### What to build
Write ADR 11 supplement specifying Working Memory time-window dedup: dedup hash = `SHA256(scope_id|entity_id|event_type|payload_hash)` with 5-minute `created_at` window, applied at Phase 2.

### Acceptance criteria
- [ ] Two identical tool calls from different ancestors within 5 min → only first persisted
- [ ] Dedup hash formula excludes predecessor_hash
- [ ] Two identical calls more than 5 min apart → both persisted
- [ ] Existing version_hash structural dedup unchanged

### Files likely involved
<!-- agent decides -->

---

## Task 6: Research — Traversal Algebra for CrossScopePatternDiscovery (G1 gap)

**Type:** spike
**Effort:** 2 context windows

### What to build
Research spike: evaluate Cayley/Gizmo traversal algebra against execution graph schema. Produce written recommendation on whether to adopt Cayley, build custom, or use alternative. Include one example structural query HNSW cannot express.

### Acceptance criteria
- [ ] Written recommendation: adopt / build / alternative with rationale
- [ ] At least one example structural query documented (e.g. "entities with 3+ consecutive conflicts in 30 scopes")
- [ ] Verdict on whether Phase 1 schema changes needed
- [ ] If no winner: gap documented, G2 explicitly deferred

### Files likely involved
<!-- agent decides -->

---

## Task 7: Research — Pattern Definition Language for TemplateProposalWorker (G2 gap)

**Type:** spike
**Effort:** 2 context windows

### What to build
Research spike: evaluate Peregrine FSM subgraph pattern mining for `template_graph` field format. Produce recommendation that enables machine-comparable template outputs across TemplateProposalWorker runs.

### Acceptance criteria
- [ ] Written recommendation for a PDL compatible with execution graph schema
- [ ] Two TemplateProposalWorker runs on identical DAGs → machine-comparable outputs
- [ ] `template_graph` JSONB field format confirmed or updated (not LLM prose)
- [ ] If no winner: minimum required field structure documented

### Files likely involved
<!-- agent decides -->

---

## Task 8: ADR 25 supplement — Embedding Training Strategy for topology_embedding vector(128)

**Type:** docs
**Effort:** 2 context windows

### What to build
Write ADR 25 supplement defining training set construction, negative sampling strategy, evaluation metrics (MRR, Hits@10), and incremental update protocol for `topology_embedding vector(128)`.

### Acceptance criteria
- [ ] Training set construction method defined
- [ ] Negative sampling strategy defined
- [ ] Evaluation metrics: MRR and Hits@10 specified
- [ ] Incremental update protocol defined (no full retraining on new traces)
- [ ] Supplement explicitly states: 128-dimension is FROZEN, changing requires full schema migration

### Files likely involved
<!-- agent decides -->

---

## Task 9: Materialized Traversal Cache — scope_lineage_view or Redis (Phase 2 perf)

**Type:** feature
**Effort:** 3 context windows (~500K–700K tokens)

### What to build
Implement predecessor chain caching via PostgreSQL materialized view (`scope_lineage_view`) or Redis in-memory cache, so Knapsack Slicing query time does not grow linearly with Scope depth beyond 50 tasks.

### Acceptance criteria
- [ ] Scope >50 tasks: Knapsack predecessor lookup does not grow linearly
- [ ] Either `CREATE MATERIALIZED VIEW scope_lineage_view` or Redis cache implemented
- [ ] Cache unavailable: graceful fallback to direct `execution_event_log` query
- [ ] Phase 1 composite index `idx_scope_{id}_pending_lookup` NOT removed

### Files likely involved
<!-- agent decides -->

---

## Task 10: Pi Sandbox Rehearsal Mode + OCC — new ADR (Phase 4)

**Type:** spike
**Effort:** 2 context windows

### What to build
Write Phase 4 ADR for Pi Sandbox Rehearsal Mode: Pi SDK `runtime.fork(entryId)` + `SessionManager.inMemory()` for in-memory topology pre-validation before OCC batch commit, with explicit relationship to ADR 03.

### Acceptance criteria
- [ ] ADR specifies: `runtime.fork(entryId)` + `SessionManager.inMemory()` for rehearsal
- [ ] ADR states: rehearsal is pre-check, NOT replacement for OCC CAS atomicity
- [ ] ADR states: batch commit still requires full OCC CAS verification
- [ ] Confirmed as Phase 4 only, no Phase 1-3 changes

### Files likely involved
<!-- agent decides -->

---

## Task 11: Semantic Memory t_valid/t_invalid time interval fields (optional)

**Type:** feature
**Effort:** 1 context window

### What to build
Add `valid_from TIMESTAMPTZ` and `valid_until TIMESTAMPTZ` nullable columns to `semantic_memory` to enable direct temporal range queries without `superseded_by` chain traversal.

### Acceptance criteria
- [ ] Two new nullable columns added: `valid_from`, `valid_until`
- [ ] New records: `valid_from = created_at`
- [ ] Superseded records: `valid_until = successor.created_at`
- [ ] Pre-migration records with NULL values: queries do not error

### Files likely involved
<!-- agent decides -->

---

## Task 12: Tree-sitter Worker integration spec for TemplateProposalWorker (optional)

**Type:** docs
**Effort:** 1 context window

### What to build
Write integration spec defining Tree-sitter as an optional capability in TemplateProposalWorker for code-domain payloads, clarifying boundary with iii-lsp worker.

### Acceptance criteria
- [ ] Spec defines Tree-sitter as optional, code-domain only
- [ ] Boundary with iii-lsp worker documented (AST/entity extraction vs LSP)
- [ ] Non-code payload guard: Tree-sitter NOT invoked

### Files likely involved
<!-- agent decides -->

---

## Task 13: ADR 05 supplement — pre-create buffer pool trigger conditions and pool size (optional)

**Type:** docs
**Effort:** 1 context window

### What to build
Write ADR 05 supplement defining "high-frequency task" criteria and pool size N for the pre-create buffer pool, based on production measurement data.

### Acceptance criteria
- [ ] High-frequency task criteria defined (spawn rate threshold)
- [ ] Pool size N specified with measured or estimated basis
- [ ] Pool exhaustion fallback to on-demand creation documented
- [ ] Supplement marked "initial estimate — revise after N weeks of production data"

### Files likely involved
<!-- agent decides -->
