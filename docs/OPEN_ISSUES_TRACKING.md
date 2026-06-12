# Architecture Decision Open Issues Tracking Table
> Last updated: 2026-06-05 — 5 AFK architecture Issues (#8 #9 #11 #12 #13) resolved, ADR supplements 0045-0047 written
> Locked ADRs: 42 core ADRs (ADR 01-42) + supplemental ADRs (docs/adr/ 0045-0047 added today)
> Document version: RFC v4 / ADR v4 (incl. ADR 42)
> Full Round 2 research report: `.planning/research/deep-cross-validation-round2.md`

---

## Status Legend
- 🔴 **Blocking**: affects downstream decisions, must be resolved first
- 🟡 **Pending**: important but does not block current progress
- 🟢 **Optional**: enhancement item, does not affect core architecture
- ✅ **Resolved**: decision made, documentation update pending

---

## First Priority: Blocking Issues

### P0-D | ADR 02 implementation fix: `jsonb::text` does not guarantee lexical key order (new, 2026-05-31)
- **Background**: Cross-validation found that PostgreSQL's official documentation explicitly states `jsonb` does not guarantee any specific key order — internally it uses length-first ordering (not ascending alphabetical). ADR 02's hash function relies on `canonical_json(payload)` assuming lexical ordering, which the official docs disprove.
- **Decision**: ✅ **Decided** (2026-05-31) — `canonical_json` must be implemented at the application layer (Rust/TypeScript) via recursive `BTreeMap` serialization; PostgreSQL receives already-normalized TEXT. **`jsonb::text` conversion inside PostgreSQL is prohibited.**
- **Impact scope**: ADR 02 has been updated; Phase 1 Rust crate and TypeScript Worker implementations must comply.
- **Status**: ✅ Resolved — ADR 02 has an appended correction spec (including Rust + TypeScript code)

---

### P0-A | BM25 implementation choice
- **Background**: Both research reports confirm BM25 must be added to the retrieval logic of the three memory tables (episodic/semantic/procedural), combined with pgvector via dual-track RRF fusion.
- **Decision**: ✅ **Decided** (2026-05-31) — **Option B: PostgreSQL native `tsvector + ts_rank_cd`**, zero extra dependencies. At RRF weighting 0.6:0.4, for tens-of-thousands-to-hundreds-of-thousands short-text scale, the precision gap versus true BM25 is diluted by the RRF formula and imperceptible. Fallback upgrade path: if real-world testing shows insufficient recall for technical terms, migrate painlessly to `pg_search` (ParadeDB, independently installable, no full stack required).
- **Impact scope**: ADR 20 BM25 supplemental spec confirmed; the three memory tables gain a `ts_doc tsvector GENERATED ALWAYS` column.
- **Status**: ✅ Resolved

---

### P0-B | ADR 20 supplement: BM25 + pgvector dual-track RRF hybrid retrieval spec
- **Background**: ADR 20 currently only has pgvector HNSW vector retrieval for the three memory tables, missing a BM25 track.
- **Decision**: ✅ **Decided** (2026-05-31) — **RRF k=60** (the academic standard value from Cormack et al. 2009, also the industry default in Elasticsearch/OpenSearch/Weaviate). Structure: dual-track RRF (vector_rank + bm25_rank) produces a candidate pool, then a three-signal rerank is layered on top (rrf_score × 0.6 + quality × 0.3 + recency × 0.1). quality/recency are not part of RRF — they remain in the rerank layer.
- **Impact scope**: ADR 20 supplemental document, RFC §4.4 dual-track retrieval
- **Status**: ✅ Resolved (full SQL template in `.planning/research/verify-bm25-rrf.md`)

---

### P0-C | Trigger spec for the divergent reflection track (Issue 21, resolved)
- **Background**: RFC §4.4 defines three trigger scenarios (conflict_detected, macro-planning, cold start), but the full post-trigger flow was undecided.
- **Decision**: ✅ **Decided** (2026-05-31):
  1. **Unified `mem::reflect` function** (Option A): implemented at the iii-engine layer, encapsulating the three-table RRF query + token budget truncation. The Worker only passes `{query_text, query_embedding, trigger_type, w_max, scope_id}` and receives formatted injection content. Aligns with RFC §2.1's "brain layer" positioning and ADR 05 permission isolation.
  2. **Injection spec**: budget = `min(2000, W_max × 0.3)`, structured as an independent `[REFLECTION MEMORY]` partition, truncated in Procedural > Episodic > Semantic order.
  3. **Token budget allocation**: **sequential greedy truncation**, no fixed ratio preset. Procedural is taken first (LIMIT 1-3, naturally capped), remaining budget goes to Episodic (LIMIT 5), then whatever remains to Semantic (LIMIT 5). Total is typically 600-1200 tokens, well under the 2000-token ceiling. Trigger-type differentiation: `conflict_detected` lowers the ceiling to `min(1000, W_max × 0.2)`.
- **Impact scope**: ADR 21 has been archived (`docs/adr/0022-adr21-reflection-track-trigger-spec.md`)
- **Status**: ✅ Resolved, ADR 21 written

---

## Phase 2 Mandatory Fixes

### P0-E | Control Plane OOM status — must fix before Phase 2 integration

- **File**: `packages/control-plane/src/watchdog.ts`
- **ADR reference**: ADR 38
- **Problem**: `handleContextOom(tier=3)` writes `status='terminated'`, but ADR 38 mandates that OOM suspension events must write `status='suspended'`.
- **Status**: ✅ **Fixed** (confirmed via code review on 2026-06-05) — line 200 of `watchdog.ts` now writes `'suspended'` on the OOM path, `scope_lineage` is synchronously updated to `status='suspended'`, and the fix aligns with the ADR 38 spec.

---

## Second Priority: Important Pending Issues

### P1-A | Verification of available iii-engine Workers
- **Background**: Four candidate components in the `harness` module: `llm-budget`, `context-compaction` (corresponding to ADR 14/16), `approval-gate`, and `turn-orchestrator` (multi-turn coordinator)
- **Decision**: ✅ **Resolved** (2026-05-31 Round 2 verification) — **None of the above four components exist in the public iii registry.** The public registry only contains infrastructure Workers (postgres, redis, kafka, etc. — 19 total). `approval-gate` is an iii **design pattern** (an explicit check inside a condition function), not a downloadable Worker binary. `llm-budget`/`context-compaction`/`turn-orchestrator` must be implemented as **self-built iii Functions**.
- **iii harness three tiers**: autonomous (minimal) → supervised (includes approval gates) → deterministic (explicit paths). Tiers change by adding/removing Functions — no re-architecture required.
- **Impact scope**: ADR 14/16 notes updated: "implemented as a self-built iii Function, not a registry Worker." Phase 1 scope includes building the llm-budget Function.
- **Status**: ✅ Resolved (cannot be simplified via the registry — all must be self-built)

---

### P1-B | Relationship between the Pi sandbox rehearsal mode and OCC
- **Background**: Use the Pi sandbox to simulate advancing graph topology without polluting the PostgreSQL primary ledger, then commit in bulk once confirmed conflict-free.
- **Analysis** (2026-05-31 Round 2):
  1. **Implementation path identified**: the Pi SDK's `runtime.fork(entryId)` + `SessionManager.inMemory()` can rehearse graph topology in memory without writing to PostgreSQL.
  2. **Relationship to ADR 03**: rehearsal happens outside PostgreSQL (pure in-memory); bulk commits still go through the Writable CTE OCC path. Rehearsal is a "pre-check" for OCC conflicts, reducing wasted commit attempts — it does not replace OCC's atomicity guarantee.
  3. **Atomicity guarantee**: a full OCC CAS check is still required at commit time (other Workers may have written concurrently; the rehearsal result does not guarantee the latest state).
- **Conclusion**: worth introducing, but it's a Phase 4 optimization item — does not block Phase 1-3. An ADR (Pi Sandbox ADR) will be written during Phase 4 planning.
- **Impact scope**: new ADR (Phase 4); ADR 03 requires no changes
- **Status**: 🟢 Downgraded to a Phase 4 tracking item, does not block Phase 1

---

### P1-C | Relationship between the iii-database worker's change feeds and ADR 09
- **Background**: Pi research mentioned that the iii-database worker supports change feeds, possibly replacing LISTEN/NOTIFY
- **Decision**: ✅ **Resolved** (2026-05-31 Round 2 verification) — **ADR 09's LISTEN/NOTIFY + HWM design is correct and requires no revision.** iii's `postgres` worker trigger type is `sql::query::execute` (query-level events), not row-level CDC. iii's internal "change feeds" refer to `iii-stream`'s `StreamChangeEvent` (changes to iii's own KV data), unrelated to PostgreSQL. PostgreSQL natively supports WAL logical-replication CDC, but its overhead far exceeds LISTEN/NOTIFY and is over-engineering for an append-only event log.
- **Impact scope**: ADR 09 requires no changes. tokio-postgres integration confirmed (`poll_message()`).
- **Status**: ✅ Resolved (ADR 09 design is correct)

---

### P1-D | Add agentmemory's reinforcement SQL to ADR 20
- **Background**: When a template is successfully adopted, the reinforcement counter on `procedural_memory` needs to be updated
- **Pending (content clear)**:
  ```sql
  UPDATE procedural_memory
  SET success_count = success_count + 1,
      last_used_at = NOW()
  WHERE id = $matched_template_id;
  ```
- **Impact scope**: ADR 20 operational-spec supplement
- **Status**: ✅ Content clear, documentation update pending

---

### P1-E | Add Privacy Filter (write-guard layer) implementation spec
- **Background**: agentmemory automatically strips API keys, secrets, and `<private>` tags before writing; our payload write path lacked an equivalent mechanism
- **Implementation** (confirmed via code review on 2026-06-05):
  - **Location**: `packages/shared/src/write-guard.ts` (pure function `writeGuard(payload: string): string`)
  - **Coverage patterns**: OpenAI/Anthropic API keys (`sk-[A-Za-z0-9-_]{32,}`), AWS access keys (`AKIA...`), PostgreSQL/MySQL connection strings, `<secret>...</secret>` tags → replaced with `[REDACTED:secret_type]`
  - **Tests**: covered by `packages/shared/src/write-guard.test.ts`
- **Impact scope**: ADR 22 supplement (`memory::write_guard` implemented as a `@graph/shared` pure function)
- **Status**: ✅ **Implemented** (code in working tree, pending commit) — ADR 22's `explicit exclusions` section now notes `memory::write_guard` as a pure-regex implementation

---

### P1-G | ADR 42 — AgentCard skill granularity standard
- **Background**: ADR 42 defines `agent_registry.skills TEXT[]`, but the granularity standard for a skill is undefined.
- **Pending**: coarse-grained (`"code"`) vs. fine-grained (`"typescript"`, `"sql-migration"` as separate entries). Coarse-grained routing is flexible but low-precision (any Agent that "can code" matches), fine-grained is high-precision but requires the task spawner to know the executor's internal capabilities.
- **Impact scope**: ADR 42 `agent_registry` schema + FrontierScheduler matching logic
- **Status**: 🟡 Must decide before Phase 3 planning — affects FrontierScheduler implementation complexity

---

### P1-H | ADR 42 — FrontierScheduler cyclic-dependency detection priority
- **Background**: ADR 42 D-6 requires FrontierScheduler to check the `spawned_by` chain at dispatch time, reject DAG cycles, and return `ERR_CYCLE_DETECTED`.
- **Pending**: must this check be implemented in Phase 3, or is it a Phase 4 optimization? Consequence of not implementing it in Phase 3: cyclic dependencies can only be caught via Task TTL + Watchdog timeout fallback, introducing unnecessary wait latency.
- **Impact scope**: ADR 42 D-6, ADR 31 FrontierScheduler
- **Status**: 🟡 Priority to be decided during Phase 3 planning

---

### P1-I | ADR 42 — `wait_all_tasks` timeout semantics
- **Background**: ADR 42 defines the `wait_all_tasks(task_ids, timeout_s)` tool, but the behavior when some of N tasks time out is undefined.
- **Pending**: on timeout, return a partial result `{ completed: [...], timeout: [...] }`, or return a uniform error? The former is friendlier to callers but adds branching logic; the latter is semantically simple but forces the caller to redo everything.
- **Impact scope**: ADR 42 MCP Server layer implementation
- **Status**: 🟡 To be decided at Phase 3 implementation time, does not block planning

---

### P1-F | Add SHA-256 dedup window to the implementation spec
- **Background**: agentmemory performs SHA-256 deduplication (5-minute window) when capturing raw observations, to prevent identical tool calls from being repeatedly stored in Working Memory
- **Analysis** (2026-05-31 Round 2):
  - **Existing structural dedup**: the version hash formula `SHA256(scope|entity|predecessor|event_type|canonical_json(payload))` includes predecessor_hash, so identical writes under the same ancestor are naturally blocked by the unique constraint.
  - **Uncovered scenario**: an identical tool call occurring under different ancestor nodes (different predecessors) produces a different version_hash → version-hash dedup doesn't catch it. High-frequency Working Memory tool calls may produce semantically duplicate records.
  - **agentmemory's approach**: dedup hash = `SHA256(scope_id|entity_id|event_type|payload_hash)` + a 5-minute `created_at` window filter (excludes predecessor_hash).
  - **Phase 1 decision**: do not implement time-window dedup; rely on structural dedup. Add Working Memory time-window dedup in Phase 2 (5-minute window, ADR 11 supplement).
- **Impact scope**: ADR 11 supplemental spec (Phase 2)
- **Status**: 🟡 Not implemented in Phase 1; to be added to ADR 11 in Phase 2

---

## Third Priority: Optional Enhancements

### G1 | No traversal algebra — Cayley comparison gap
- **Background**: Knapsack Slicing is a fixed SQL algorithm and cannot express ad-hoc graph traversal queries (e.g., "find all entity chains with 3 consecutive conflicts across the last 30 Scopes," "count instances of explore→hypothesize→validate→converge across cross-domain topologies"). Cayley (Gizmo API) demonstrates a complete traversal algebra (morphisms, filters, multi-hop path expressions).
- **Blocking scope**: Phase 2's CrossScopePatternDiscoveryWorker needs cross-Scope topology comparison; currently only HNSW vector similarity is available — vector queries cannot express precise structural graph queries.
- **Phase 1 impact**: no direct blocker. The Phase 1 schema (execution_event_log + indexes) design should not preclude adding a graph query layer in the future.
- **Status**: 🟡 Phase 2 pre-research, does not block Phase 1

---

### G2 | No formal Pattern Definition Language — Peregrine comparison gap
- **Background**: TemplateProposalWorker uses an LLM to qualitatively extract execution patterns, producing an unstructured JSON `template_graph`. Peregrine (FSM) demonstrates precise subgraph pattern mining: patterns are declared (edge-list format) and the runtime exactly enumerates all matches.
- **Problem**: two runs of TemplateProposalWorker on structurally identical DAGs may extract semantically similar but literally different templates, so `topology_embedding` similarity may be high while `template_graph` cannot be compared programmatically. Verifiability of pattern emergence is zero.
- **Phase 1 impact**: no direct blocker. The JSONB field format of `template_graph` leaves room for this (avoiding freezing it as unparseable LLM prose).
- **Status**: 🟡 Phase 2 pre-research (co-designed with G1's traversal algebra), does not block Phase 1

---

### G3 | No embedding training strategy — GraphVite comparison gap
- **Background**: ADR 25 defines `topology_embedding vector(128)` (WL graph kernel), but the training loop, evaluation metrics, and incremental-update protocol are undefined. GraphVite demonstrates a complete knowledge-graph embedding (TransE, RotatE) training pipeline: training-set construction → negative sampling → evaluation (MRR, Hits@10) → incremental update.
- **Phase 1 critical impact**: the `procedural_memory.topology_embedding vector(128)` column **must be correctly declared in the Phase 1 schema** (the column dimension cannot be changed once live). Phase 1's TemplateProposalWorker computes and writes the WL embedding (stub implementation). The training strategy is defined in Phase 2, but Phase 1 must not use the wrong dimension.
- **ADR 25 status**: `vector(128)` is locked, the WL kernel computation method is locked. Pending: training/evaluation spec (Phase 2 ADR 25 supplement).
- **Status**: ✅ Resolved — ADR 25 supplement written to `docs/adr/0047-adr25-supplement-embedding-training-strategy.md` (training-set construction, MRR/Hits@10 evaluation metrics, incremental-update protocol, vector(128) freeze declaration); Issue #8 closed (e79ee94)

---

### G4 | No materialized traversal cache — codegraph comparison gap
- **Background**: Knapsack Slicing recomputes the predecessor chain from raw `execution_event_log` every time, with no precomputed path cache. codegraph (tree-sitter + SQLite pre-indexing) shows that precomputing structural relationships can reduce token consumption by 57% and tool calls by 71%. Knapsack query latency grows linearly with Scope depth.
- **Phase 1 impact**: pure performance issue, does not affect correctness. Phase 1 targets ≤50 tasks per Scope, where the current composite index (ADR 05 `idx_scope_{id}_pending_lookup`) is sufficient.
- **Mitigation path**: Phase 2 could consider a materialized view of the predecessor chain (`CREATE MATERIALIZED VIEW scope_lineage_view`) or a Redis in-memory cache (most recent N predecessors).
- **Status**: ✅ Resolved — migration 009 creates the `scope_lineage_view` materialized view (with a unique index supporting REFRESH CONCURRENTLY); scope-read.ts adds view-first with fallback to direct query; watchdog.ts performs a non-blocking refresh after scope_closed; the Phase 1 composite index is retained; Issue #9 closed (e79ee94)

---

### P2-A | Add t_valid/t_invalid validity-interval fields to Semantic Memory
- **Background**: in Graphiti (Zep AI)'s knowledge graph, every edge carries an explicit validity interval, enabling temporal queries ("what was the state of knowledge at time T"). Our `semantic_memory`'s `superseded_by` chain lacks an explicit validity interval
- **Pending**: should `semantic_memory` gain `valid_from`/`valid_until` fields to enhance temporal querying?
- **Impact scope**: ADR 20 semantic_memory table structure
- **Status**: ✅ Resolved — migration 008 adds `valid_from` / `valid_until` columns + a BEFORE UPDATE trigger (auto-stamps valid_until when superseded_by transitions NULL→non-NULL); SemanticMemoryWorker sets valid_from = NOW() on INSERT; Issue #11 closed (e79ee94)

---

### P2-B | Tree-sitter integration spec at the Worker layer
- **Background**: Tree-sitter is well suited for code-entity extraction and dependency-topology analysis when TemplateProposalWorker distills golden templates; the iii-lsp worker already provides LSP support
- **Pending**: should Tree-sitter be formally defined as an optional Worker-layer capability, with a written implementation spec?
- **Impact scope**: implementation-spec chapter (not core ADR)
- **Status**: ✅ Resolved — integration spec written to `docs/adr/0046-treesitter-templateproposal-integration-spec.md` (code-domain guard, AST entity extraction, boundary with iii-lsp, best-effort error handling); Issue #12 closed (e79ee94)

---

### P2-C | ADR 05 pre-created buffer pool trigger conditions and pool size
- **Background**: ADR 05 allows enabling a pre-created buffer pool, but pool size and trigger conditions are undefined
- **Pending**: what is the criterion for "high-frequency tasks"? How should pool size N be set?
- **Impact scope**: ADR 05 supplement
- **Status**: ✅ Resolved — ADR 05 supplement written to `docs/adr/0045-adr05-supplement-buffer-pool-trigger.md` (trigger threshold ≥10 Scopes/min, N = max(ceil(rate×2), 5), transparent degradation on pool exhaustion, 24h GC window, including initial estimation caveats); Issue #13 closed (e79ee94)

---

### P2-D | Memory Synthesizer's Semantic Memory induction trigger frequency
- **Background**: ADR 20 defines that Semantic Memory is written "during cross-Scope induction," but the specific trigger frequency for induction is undefined
- **Plan defined** (2026-05-31 Round 2): **dual-trigger strategy**
  - **Primary trigger**: daily at 2am via iii-cron (`expression: '0 0 2 * * * *'`, 7-field format)
  - **Optional supplement**: triggered after scope_closed once ≥20 episodic memory entries have accumulated (event-driven, low frequency)
  - iii-cron worker confirmed available, simple to configure (see Round 2 research report)
- **Impact scope**: ADR 20 §Memory Synthesizer trigger conditions
- **Status**: 🟢 Content clear, can be written into the ADR 20 supplement

---

### P2-E | iii-cron worker integration: Ebbinghaus decay scan scheduling spec
- **Background**: Semantic/Procedural Memory needs periodic scans for low-reinforcement_count or long-unused memories, to apply decay
- **Plan defined** (2026-05-31 Round 2):
  - **Schedule**: daily at 3am (staggered after the induction scan): `expression: '0 0 3 * * * *'`
  - **Decay threshold**: `reinforcement_count = 0` AND `last_used_at < NOW() - INTERVAL '90 days'`
  - **Operation**: mark `superseded_by = id` (logical deletion, per the append-only principle), no physical DELETE
  - iii-cron worker's 7-field cron format confirmed
- **Impact scope**: new operational spec, iii-config.yaml configuration
- **Status**: 🟢 Content clear, can be written into the operational spec

---

## Resolved, Documentation Update Pending

| ID | Content | Corresponding ADR |
|---|---|---|
| ✅ D-1 | agentmemory reinforcement SQL: update success_count + last_used_at after a template is adopted | ADR 20 |
| ✅ D-2 | Edge Weight is fully superseded by the final_score signal system; no explicit field needed | ADR 20 |
| ✅ D-3 | Tree-sitter is positioned as an optional Worker-layer tool, not part of the storage layer | Implementation spec |
| ✅ D-4 | **ADR 20 NULL bug fixed**: `COALESCE(last_used_at, NOW())` is correctly in place in ADR_v4.md §ADR20 SQL and the 0021 supplement SQL; the incorrect `created_at` fallback suggestion in the ADR_v4.md notes has been corrected to `NOW()`. | ADR 20 + supplements |
| ✅ P0-G | **Agent integration protocol decided (Phase 1 blocker)**: HTTP REST Gateway, 3 endpoints (POST /v1/scopes, POST /v1/scopes/{id}/events, GET /v1/scopes/{id}), each event POST synchronously returns the Knapsack-assembled context. ADR 24 archived. MCP Adapter is a thin Phase 2 wrapper. | ADR 24 (0026-adr24-agent-entry-point-protocol.md) |
| ✅ P0-H | **ADR 19 Level 3 SQL bug fix (v2)**: the original `task_spawned AND payload->>'status' != 'completed'` is always true in an append-only system, so the watchdog could never trigger scope_closed. Fixed to `NOT EXISTS(memory_updated WHERE entity_id=t.entity_id AND status='completed')`, aligning with the Level 1 in-memory counting semantics. | ADR 19 |
| ✅ P0-I | **Task-completion signal convention**: after completing a task, a Worker writes a `memory_updated` event with `entity_id` = the task node's UUID and `payload.status = "completed"`. The ADR 12 event table comments have been updated. `task_spawned` initially writes `payload.status = "pending"`. | ADR 12 + ADR 19 |
| ✅ P0-J | **Cross-domain topology discovery algorithm decided**: WL graph kernel (h=3 iterations, event_type labels, O(n×d), no training required) → stored as `topology_embedding vector(128)` in `procedural_memory`. Phase 1: TemplateProposalWorker computes the embedding (schema stub); Phase 2: CrossScopePatternDiscoveryWorker periodically discovers cross-domain similar pairs. ADR 25 archived. | ADR 25 (0027-adr25-cross-domain-topology-algorithm.md) |
| ✅ G8 | **Event-as-Snapshot philosophy locked**: `memory_updated` = a complete entity-state snapshot; fold/reduce is prohibited. State derivation = `SELECT payload WHERE version_hash = $tip`. Replay verification = version_hash ciphertext collision, not state-semantic projection. ADR 26 archived. | ADR 26 (0028-adr26-event-as-snapshot-philosophy.md) |
| ✅ G5 | **Worker lifecycle state machine**: four phases (Initializing→Processing→Writing→Terminated), no in-memory mutation during Processing, Knapsack failure bifurcation (context too large→OOM path; system overload→re-enqueue with N=3 cap), untriggered events may be silently dropped. ADR 27 archived. | ADR 27 (0029-adr27-worker-lifecycle-state-machine.md) |
| ✅ G6 | **Operational determinism**: convergence is determined by **pure algebraic SQL** (`pending=0 AND conflicts=0`); time windows/probabilistic thresholds/approximate counts are prohibited. The WITH-clause versioned SQL is folded into ADR 28. | ADR 28 (0030-adr28-scheduling-spec-and-operational-determinism.md) |
| ✅ G7 | **Scheduling spec**: Max_Parallelism is dynamically derived from iii-config.yaml parameters (`⌊TPM/calls_per_min/avg_tokens⌋`); token-bucket rate limiting + FIFO pending queue; ConflictResolverWorker uses entity-level single-writer mutual exclusion (ActiveResolverRegistry). ADR 28 archived. | ADR 28 (0030-adr28-scheduling-spec-and-operational-determinism.md) |

---

## Issue Dependency Graph

```
P0-A (BM25 selection)
    └── P0-B (ADR 20 hybrid retrieval supplement)
            └── P0-C (reflection track trigger spec, ADR 21)

P1-A (iii worker verification)
    └── may affect ADR 14/16 simplification

P1-C (iii-database change feeds)
    └── may affect ADR 09 revision

P1-B (Pi sandbox rehearsal)
    └── independent decision, does not block other issues

P1-D/E/F (agentmemory borrowed details)
    └── all are local supplements to ADR 20 / implementation spec, mutually non-blocking
```

---

## Suggested Processing Order

```
Round 1 (this session):
  1. P0-A: finalize BM25 selection
  2. P0-B: add ADR 20 hybrid retrieval supplement
  3. P0-C: Issue 21 reflection track trigger spec (ADR 21)

Round 2 (can be researched before the next session):
  4. P1-A: verify whether iii harness workers are public
  5. P1-C: verify iii-database change feeds details

Round 3 (after the architecture stabilizes):
  6. P1-B: decide on Pi sandbox rehearsal mode
  7. P1-D/E/F: add agentmemory-borrowed details to documentation
  8. P2-A~E: optional enhancements, decide as needed
```

---

*Last sync: 2026-06-05, commit e79ee94 — all 5 AFK Issues resolved (G3/G4/P2-A/B/C)*
*All P0 ✅; G3/G4/P2-A/B/C ✅ (closed today); P1-A/C/E ✅*
*Pending (Phase 3 decisions): P1-G/H/I (ADR 42 skills granularity, cycle detection, timeout semantics)*
*Documentation pending: P1-D (reinforcement SQL), P1-F (SHA-256 dedup Phase 2), P2-D (induction frequency), P2-E (Ebbinghaus scheduling)*
*Optional research: G1 (Traversal Algebra), G2 (Pattern Definition Language); P1-B downgraded to Phase 4*

---

**2026-06-11 update:** all open items have been folded into `.harness/ROADMAP.md`'s "Tech Debt Repayment Track" and assigned to repayment phases — P1-F/G2/P1-D/P2-D/P2-E → Phase 10; P1-G/P1-H/`wait_all_tasks` polling upgrade → Phase 13; P1-B → Phase 13 optional; G1 → post-1.0 candidate. This table no longer tracks scheduling independently — the ROADMAP section is authoritative.

**2026-06-11 Phase 10 closeout:** P1-F ✅ (ADR-51, processAgentTurn production wiring); G2 ✅ (ADR-50, template_graph canonical schema + isomorphism matching); P1-D ✅ (ADR-52 §1, TemplateProposalWorker Step 6 caller-side landed); P2-D ✅ (ADR-52 §2, event-trigger explicitly not implemented); P2-E ✅ (ADR-52 §3).
