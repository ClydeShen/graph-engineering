---
phase: 4
reviewers: [gemini]
skipped: {opencode: "no credentials configured"}
reviewed_at: 2026-06-05T13:09:09Z
plans_reviewed: [04-PLAN.md]
---

# Cross-AI Plan Review — Phase 4: External Integrations

## Gemini Review

# Phase 4 Plan Review: External Integrations

## 1. Summary
The Phase 4 implementation plan for the **Graph-Native Agent Runtime** is a well-structured progression from core infrastructure (locking, config) to agent-specific integration (Pi/Claude) and developer experience (CLI). The strategy of using a **Shadow Adapter** to intercept agent "rehearsals" is an elegant solution to the problem of AI hallucination and destructive writes during exploratory "forks." The transition from in-memory locks to PostgreSQL advisory locks is a necessary step for distributed reliability. Overall, the plan is technically dense and aligns perfectly with the "event-graph-as-truth" philosophy, though it carries some operational risks regarding database connection behavior and LLM context limits.

---

## 2. Strengths

- **Logical Wave Structure:** The separation into "Foundations" (Wave 1), "Real-time Processing" (Wave 2), and "Delivery" (Wave 3) minimizes dependency blocking and ensures that the CLI (Task 6) is built on verified integrations.
- **Shadow Write Interception:** The `InMemoryShadowAdapter` approach is a clever architectural "safety valve." It allows the agent to believe it is interacting with a standard OCC-compliant database while maintaining total isolation from the production event log.
- **Advisory Lock Semantics:** Using `pg_try_advisory_lock` (non-blocking) instead of `pg_advisory_lock` (blocking) correctly respects the project's OCC (Optimistic Concurrency Control) philosophy — skipping work is preferred over creating a bottleneck of waiting processes.
- **Operational Discipline:** The inclusion of the `sampling_ratio: 0.1` fix in Task 1 shows high awareness of previous failure modes (log feedback loops) and prioritizes system stability.

---

## 3. Concerns

### HIGH: Advisory Lock + Connection Pooling Interaction
- **Issue:** PostgreSQL advisory locks are **session-scoped**. In a typical Node.js `pg.Pool` environment, or if using a middle-man like **pgBouncer** in transaction mode, the "session" is not guaranteed to remain tied to the specific worker process.
- **Risk:** If a connection is returned to the pool without being explicitly unlocked (e.g., due to an unhandled exception or pool timeout), the lock remains "held" by that connection. When another worker checks out that same connection, it may inadvertently hold a lock it didn't request, leading to "stuck" entities or unpredictable "skipped" tasks.
- **Severity:** HIGH

### MEDIUM: Fragile SQL Detection in Shadow Adapter
- **Issue:** Task 3 relies on `sql.trimStart().startsWith('WITH new_version AS')` to detect OCC writes.
- **Risk:** This is highly susceptible to false negatives. Comments at the start of the query (e.g., `-- query for worker X`), variations in whitespace, or future changes to the OCC SQL template will bypass the shadow guard, potentially causing permanent writes to the DB during a "rehearsal" fork.
- **Severity:** MEDIUM

### MEDIUM: CrystallizeWorker Token Budget
- **Issue:** Task 4 proposes querying `episodic_memory` and sending it to an LLM for digest without a specified windowing or limit check (`W_max`).
- **Risk:** For long-running scopes or "chatty" agents, the episodic memory could easily exceed the LLM's context window (OOM) or incur massive costs. The plan lacks a "head/tail" truncation strategy or a token-count gate before the LLM call.
- **Severity:** MEDIUM

### LOW: Connect CLI Path Portability
- **Issue:** The plan mentions `~/.claude.json`.
- **Risk:** On Windows (`win32`), Claude Desktop usually stores MCP configurations in `%APPDATA%\Claude\claude_desktop_config.json`. On macOS, it's `~/Library/Application Support/Claude/claude_desktop_config.json`. The CLI needs to be platform-aware to find these paths correctly.
- **Severity:** LOW

---

## 4. Suggestions

- **Safe Advisory Locking:** Wrap the advisory lock call in a **transaction-level lock** (`pg_advisory_xact_lock`) if possible, or ensure the `ConflictResolverWorker` uses a dedicated, non-pooled connection for the duration of the lock/unlock cycle to prevent session leakage.
- **Robust Shadow Detection:** Instead of string-matching SQL, consider tagging the "Rehearsal" context in the `ExtensionContext`. The `InMemoryShadowAdapter` should be explicitly toggled via a constructor flag or a dedicated `setShadowMode(true)` method, rather than trying to "guess" based on the SQL string.
- **Crystallization Windowing:** Update `CrystallizeWorker` to only fetch the last *N* events or use a semantic search to pull the most relevant traces if the total event count exceeds a certain threshold (e.g., 50 events).
- **Automate Integration Testing:** Task 7 relies on manual verification. Given the complexity of the `ShadowAdapter` and `AdvisoryLocks`, an automated integration test in `tests/integration/shadow-lock.test.ts` that spawns two processes and verifies the lock collision/shadow isolation is highly recommended.
- **Fingerprint Migration:** Ensure the `004-add-fingerprint-id.sql` uses `DO $$ ... BEGIN ... END $$` blocks to check for table existence before attempting to add columns or unique indexes, preventing migration failures in partially initialized environments.

---

## 5. Risk Assessment
**Overall Risk: MEDIUM**

**Justification:**
The core logic of the integrations is sound, and the "Shadow" mechanism provides a strong safety net for external agents. However, the combination of **session-level database locks** and **Node.js connection pooling** is a classic source of production "ghost" bugs that are difficult to debug. If the locking strategy is hardened and the SQL detection in the Shadow Adapter is made more robust, this phase will be a significant leap forward for the runtime's utility.

---

## OpenCode Review

*Skipped — no credentials configured (`opencode providers list` shows 0 credentials). Run `opencode providers add` to enable.*

---

## Consensus Summary

Only one reviewer completed (Gemini). Treating Gemini's findings as the authoritative review.

### Key Findings

**Strengths (confirmed):**
- Wave structure (foundation → integration → delivery) is sound
- InMemoryShadowAdapter isolation design is architecturally correct
- pg_try_advisory_lock (non-blocking) correctly respects OCC philosophy
- sampling_ratio: 0.1 fix shows operational awareness

**Concerns to address before execution:**

| Priority | Finding | Task | Action |
|---|---|---|---|
| HIGH | Advisory lock session-scope + connection pooling risk | T2 | Investigate pg_advisory_xact_lock or dedicated connection |
| MEDIUM | SQL string detection fragility in shadow adapter | T3 | Document assumption; add test for whitespace/comment variants |
| MEDIUM | CrystallizeWorker has no token budget gate before LLM call | T4 | Add LIMIT N to episodic_memory query |
| LOW | `~/.claude.json` path not cross-platform | T6 | Add platform detection (win32 → APPDATA, darwin → Library) |

### Divergent Views
N/A — single reviewer.

### Recommendation
**Proceed with execution** — overall risk is MEDIUM, all concerns are addressable during implementation. The HIGH concern (advisory lock pooling) should be addressed in T2 before moving to Wave 2.
