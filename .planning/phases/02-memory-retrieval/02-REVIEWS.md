---
phase: 2
reviewers: [gemini, opencode]
reviewed_at: 2026-06-04T00:00:00.000Z
plans_reviewed:
  - 02-01-PLAN.md
  - 02-02-PLAN.md
  - 02-03-PLAN.md
  - 02-04-PLAN.md
  - 02-05-PLAN.md
  - 02-06-PLAN.md
  - 02-07-PLAN.md
  - 02-08-PLAN.md
reviewer_notes:
  gemini: "Returned Phase 1 Gate 2 review (persistent session context). Cross-cutting writeGuard regex concern extracted."
  opencode: "Failed — local Qwen model server offline."
---

# Cross-AI Plan Review — Phase 2: Memory & Retrieval

## Gemini Review

> **Note:** Gemini CLI returned a Phase 1 Gate 2 review due to persistent session context from a prior review run. The full output is preserved below. Cross-cutting concerns (writeGuard regex gaps) apply to Phase 2 plans as well and are incorporated into the Consensus Summary.

The following is a structured review of the Phase 2 Gate 2 implementations for the **Graph-Native Agent Runtime**.

### 1. Summary
The implementation successfully meets the core functional requirements for Gate 2, providing the requested system health and topology endpoints while establishing a privacy layer for event payloads. The use of centralized UUID v4 validation and adherence to the append-only TEXT payload invariant demonstrate a strong commitment to system integrity. However, the privacy filter (writeGuard) and the health reporting logic exhibit superficiality that could lead to security bypasses or misleading operational signals in a production environment.

### 2. Strengths
- **Architectural Consistency:** The topology endpoint correctly utilizes causal ordering (ORDER BY id ASC) and the ZERO_HASH sentinel to provide a deterministic, traversable graph representation.
- **Strict Input Validation:** Integration of validateScopeIdParam ensures that invalid UUIDs are rejected at the "iron gate" before any database overhead, adhering to ADR 24.
- **Invariant Protection:** The implementations respect the TEXT payload invariant (no JSONB casting), critical for preserving the reproducibility of the canonical hash chain.
- **Standardized Data Format:** The topology adjacency list ({nodes, edges}) is idiomatic and directly compatible with modern graph visualization libraries.

### 3. Concerns

| Severity | Area | Description |
|:---|:---|:---|
| **HIGH** | Security | **writeGuard Regex Gaps:** The OpenAI regex `[A-Za-z0-9]{32,}` misses newer `sk-proj-` or `sk-org-` keys that contain underscores/dashes. More critically, it redacts the AWS Access Key ID (AKIA...) but ignores the Secret Access Key, which is the actual sensitive credential. |
| **MEDIUM** | Reliability | **Superficial Health Reporting:** engine_status: 'ok' is hardcoded. If the database is unresponsive or worker nodes are down, the endpoint may still return ok. |
| **MEDIUM** | Security | **Regex Bypass:** The writeGuard patterns for database strings (postgres://) are case-sensitive and lack the /i flag. A simple change to PostgreSQL:// would bypass redaction. |
| **LOW** | Maintainability | **Fragile Internal Access:** The health endpoint casts the pool to an internal structure to read options.max. This is a private property and may break during minor pg version upgrades. |

### 4. Suggestions
- **Enhance writeGuard Regexes:** Update OpenAI pattern to `/sk-(?:ant-)?[A-Za-z0-9\-_]{32,}/g`, add AWS Secret pattern, apply case-insensitive flags (/gi) to protocol strings.
- **Robust Health Checks:** Replace hardcoded 'ok' with a liveness probe (SELECT 1) wrapped in try/catch.

### 5. Risk Assessment: **MEDIUM**
The primary risk stems from the Privacy Filter. While it passes basic tests, it provides a false sense of security due to narrow regex definitions and lack of case-insensitive matching. Malicious or accidental variations in secret formats will bypass the filter and persist sensitive data into the immutable execution_event_log.

---

## OpenCode Review

OpenCode review failed — local Qwen model server (Qwen3.6-35B-A3B-UD-Q5_K_M.gguf) is not running. Unable to connect.

---

## Consensus Summary

Gemini returned a Phase 1 Gate 2 review (session context issue) and OpenCode was unavailable. The synthesis below is based on Gemini's cross-cutting writeGuard concern plus independent architectural analysis of all 8 Phase 2 plans.

### Agreed Strengths

- **Idempotent migration design (02-01):** All IF NOT EXISTS guards are correct. Partial UNIQUE index on working_memory (WHERE dedup_hash IS NOT NULL) elegantly handles pre-existing NULL rows from Phase 1.
- **C1 constraint discipline:** Every memory worker plan explicitly documents the two-step write pattern (pool.query INSERT + occWrite memory_updated), and tests verify occWrite is called with the correct eventType.
- **ts_doc dictionary resolution:** The decision to use plainto_tsquery('english') to match to_tsvector('english') rather than altering the GENERATED ALWAYS column is correct and well-documented.
- **WL kernel determinism (02-05):** Pure functional SHA-256 accumulation with L2 normalization, no external packages, testable for determinism. Edge-connected vs. disconnected node test correctly validates the algorithm adds value.
- **Module-level ActiveResolverRegistry (02-07):** Correct design — mutex must persist across concurrent worker instances, not be class-level state.
- **Integration test gating (02-08):** it.skipIf(!process.env.DATABASE_URL) is the correct CI-safe pattern.

### Agreed Concerns

**[HIGH] C1 constraint is not transactional — split commit risk**

Plans 02-02, 02-03, 02-05: the memory table INSERT and the occWrite C1 call are NOT wrapped in a single transaction. The INSERT commits first via pool.query, then occWrite runs. If occWrite fails (e.g., wrong predecessorHash causing OCC conflict, network failure), the memory row exists in episodic/semantic/procedural_memory with no corresponding event_log entry. This violates the C1 invariant silently.

The integration tests (02-08) acknowledge this with try/catch around the C1 call, but the workers themselves propagate the error after the INSERT has already committed. A transaction would guarantee both succeed or both fail. Without it, the system can accumulate orphaned memory rows that are invisible to the event log audit trail.

**Recommendation:** Wrap pool.query INSERT + occWrite in a single `pool.connect()` + `BEGIN/COMMIT` block, or accept and document that C1 is best-effort for memory workers (preferred since occWrite uses its own OCC logic).

---

**[HIGH] runSynthesis() does not publish to synthesizer::output topic**

Plan 02-04: `runSynthesis()` calls `this.llm.chat(...)`, assigns the result to `summary`, then immediately does `void summary`. The comment says "ProceduralMemoryWorker consumes via synthesizer::output topic (Plan 05)."

But there is no iii-sdk publish call in the plan. ProceduralMemoryWorker (02-05) subscribes to `graph::memory::synthesizer::output` via durable:subscriber — but nothing ever publishes to that topic. The ProceduralMemoryWorker will be registered but will never fire in practice.

Plan 02-04 must include an iii.publish() or equivalent iii-sdk emit to `graph::memory::synthesizer::output` with the template_graph and intent_description payload. This is the critical missing link between Wave 2 and the procedural memory chain.

**Recommendation:** Add iii publish call in runSynthesis() after the LLM call: the synthesizer output (template_graph, intent_description, nodes, edges from the episodic records) must be published to the topic for ProceduralMemoryWorker to receive it.

---

**[MEDIUM] RRF SQL returns cross-scope results — no scope isolation**

Plan 02-06: The HYBRID_RRF_SQL queries `semantic_memory` with no WHERE scope_id = ... filter. The `scope_id` query parameter is validated as UUID v4 but never used in the SQL ($1=embedding, $2=query_text, $3=limit). This means GET /v1/memory/search returns memories from ALL scopes, not just the requested scope.

The threat model notes this: "scope_id passed to query for filtering (RRF SQL can add WHERE scope_id = $4 if needed for isolation)" — but the plan does not add this filter.

In a multi-tenant or multi-agent deployment, this is a data isolation failure: Agent A can query memories from Agent B's scope by providing Agent B's scope_id.

**Recommendation:** Either (a) add scope_id as $4 to the HYBRID_RRF_SQL as a WHERE filter in both vector_candidates and bm25_candidates CTEs, or (b) explicitly document that memory search is global (cross-scope by design for pattern discovery) and remove scope_id from the route entirely.

---

**[MEDIUM] onScopeClosed (02-03) has unbounded episodic query**

Plan 02-03: `SELECT content FROM episodic_memory WHERE scope_id = $1 ORDER BY created_at ASC` — no LIMIT. For a scope with thousands of episodic records (e.g., a long-running multi-hour task), this loads all rows into memory before calling llm.chat(). The LLM will also receive an unbounded input, likely hitting context window limits and failing.

Compare with Plan 02-04 runSynthesis() which has `LIMIT 100`.

**Recommendation:** Add `LIMIT 50` (or configurable) and use the most recent records: `ORDER BY created_at DESC LIMIT 50` then reverse for chronological LLM input.

---

**[MEDIUM] writeGuard regex gaps (from Gemini — cross-cutting)**

All plans that pass content to writeGuard before INSERT or LLM: the writeGuard patterns may miss:
- `sk-proj-...` and `sk-org-...` style OpenAI API keys (contain underscores/dashes)
- AWS Secret Access Keys (40-char base64 — not matched by the AKIA... prefix pattern)
- Case-sensitive protocol strings (PostgreSQL:// vs postgres://)

This is cross-cutting across 02-02, 02-03, 02-04, 02-05, 02-06, 02-07.

**Recommendation:** Update writeGuard regexes in @graph/shared before Phase 2 execution, or add a known-limitation note.

---

**[LOW] intent_description stored without writeGuard in procedural_memory**

Plan 02-05: The INSERT params include `writeGuard(intentDescription)` as content ($2) but plain `intentDescription` as intent_description ($3). The intent_description column receives the raw unguarded string.

**Recommendation:** Apply writeGuard to intent_description as well before INSERT, or document why intent_description is trusted input (it comes from LLM output via the synthesizer, so it's already AI-generated and doesn't contain user-supplied API keys directly).

---

**[LOW] G3-4 integration test fragility (02-08)**

The G3-4 test calls `buildApp(pool)` and hits `GET /v1/memory/search`. The gateway's `buildMemoryRoute` uses `gatewayLlmProvider` (module-level singleton) which requires a running embedding server. Without a mock or a real embedding server at LLM_BASE_URL, the embedding.embed() call will fail and the route will return 500.

The test only asserts `res.status === 200` — it will fail in isolation (no embedding server).

**Recommendation:** Pass a mock embedding provider to buildApp, or add `process.env['LLM_BASE_URL']` to the integration test skip condition alongside `DATABASE_URL`.

### Divergent Views

None — only one reviewer produced relevant output (Gemini was off-target, OpenCode offline). The concerns above are from independent architectural analysis.

### Actionable Items Before Execution

1. **[BLOCKING]** Plan 02-04: Add iii-sdk publish call in runSynthesis() to emit to `graph::memory::synthesizer::output` topic with full payload (template_graph, intent_description, nodes, edges). Without this, ProceduralMemoryWorker never fires.
2. **[BLOCKING]** Plans 02-02/03/05: Decide and document C1 transaction strategy. Options: (a) wrap INSERT+occWrite in BEGIN/COMMIT, (b) accept best-effort and document the orphan risk. Current plan leaves it ambiguous.
3. **[RECOMMENDED]** Plan 02-06: Add WHERE scope_id = $4 to both CTEs in HYBRID_RRF_SQL, or document global-search intent.
4. **[RECOMMENDED]** Plan 02-03: Add LIMIT 50 to episodic SELECT in onScopeClosed.
5. **[OPTIONAL]** Plan 02-05: Apply writeGuard to intent_description before INSERT.
6. **[OPTIONAL]** Plan 02-08: Guard G3-4 with LLM_BASE_URL check or inject mock embedding.
