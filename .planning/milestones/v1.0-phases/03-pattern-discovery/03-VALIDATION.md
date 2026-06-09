---
phase: 03
slug: 03-pattern-discovery
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-06-05
---

# Phase 3 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^2 |
| **Config file** | `vitest.config.mts` (root) |
| **Quick run command** | `npx vitest run` |
| **Full suite command** | `npx vitest run` |
| **Estimated runtime** | ~30 seconds |

---

## Sampling Rate

- **After every task commit:** Run `npx vitest run`
- **After every plan wave:** Run `npx vitest run`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01-01 | 01 | 0 | GATE4-1, GATE4-2, GATE4-4 | — | Migration creates agent_registry + intent_embedding; no SQL injection via schema inputs | scaffold + typecheck | `npm run typecheck` | ✅ migration | ⬜ pending |
| 03-01-02 | 01 | 0 | GATE4-1 | — | RED scaffold: wl-embedding.test.ts asserts cosine > 0.90 (fails until Plan 03-02) | unit (RED) | `npx vitest run packages/workers/src/memory/wl-embedding.test.ts` | ❌ W0 | ⬜ pending |
| 03-01-03 | 01 | 0 | GATE4-2 | — | RED scaffold: cross-scope.test.ts asserts cluster_id written (fails until Plan 03-02) | integration (skipIf no DB) | `npx vitest run packages/workers/src/patterns/cross-scope.test.ts` | ❌ W0 | ⬜ pending |
| 03-01-04 | 01 | 0 | GATE4-4 | — | RED scaffold: mcp.test.ts asserts spawn_subtask + claim_next_task round trip (fails until Plan 03-05) | integration (skipIf no DB) | `npx vitest run packages/gateway/src/routes/mcp.test.ts` | ❌ W0 | ⬜ pending |
| 03-02-01 | 02 | 1 | GATE4-2 | T-03-02-* | cross_domain_cluster_id written; UPDATE idempotent (WHERE IS NULL guard); anti-patterns excluded | integration (skipIf no DB) | `npx vitest run packages/workers/src/patterns/cross-scope.test.ts` | ❌ W0 | ⬜ pending |
| 03-03-01 | 03 | 1 | GATE4-5 | T-03-03-* | Skill-match gates dispatch; skill-less tasks pass through unchanged; assigned_agent_id ignored (D-1 guard) | unit | `npx vitest run packages/workers/src/scheduler/frontier.test.ts` | ✅ (extend) | ⬜ pending |
| 03-04-01 | 04 | 2 | GATE4-3 | T-03-04-* | createSubScope/resolveSubScope: payload has 4 keys (child_scope_id, trigger_task_id, child_final_version_hash, parent_scope_id); ADR 12 enum unchanged; root scope no-op | integration (skipIf no DB) | `npx vitest run packages/control-plane/src/nesting.test.ts` | ❌ W2 | ⬜ pending |
| 03-04-02 | 04 | 2 | GATE4-3 | T-03-04-* | sub_scope_resolved routed to graph::scope::sub_scope_resolved topic, not frontier | unit | `npx vitest run packages/control-plane/src` | ✅ (extend) | ⬜ pending |
| 03-05-01 | 05 | 2 | GATE4-4 | T-03-05-* | spawn_subtask rejects assigned_agent_id; claim_next_task SKIP LOCKED; wait_all_tasks timeout returns error object | integration (skipIf no DB) | `npx vitest run packages/gateway/src/routes/mcp.test.ts` | ❌ W0 | ⬜ pending |
| 03-06-01 | 06 | 3 | GATE4-3 | T-03-06-* | SubScopeResultWorker: reads child node by child_final_version_hash, synthesizes via LLM, writes memory_updated to parent; not-found path writes error memory_updated and does not throw | unit | `npx vitest run packages/workers/src/nested/sub-scope-result.worker.test.ts` | ❌ W3 | ⬜ pending |
| 03-06-02 | 06 | 3 | GATE4-3 | T-03-06-* | AgentCard bootstrap: ON CONFLICT DO NOTHING makes re-boot idempotent (no duplicate rows) | unit | `npx vitest run packages/workers/src` | ✅ (extend) | ⬜ pending |
| 03-07-01 | 07 | 4 | GATE4-1~5 | — | Full Gate 4 integration: cosine > 0.90; cluster_id written; nested scope round-trip; MCP e2e; skill dispatch | integration (skipIf no DB) | `npx vitest run packages/workers/src/patterns/gate4.integration.test.ts` | ❌ W4 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/workers/src/memory/wl-embedding.test.ts` — RED scaffold: cosine similarity > 0.90 for structurally equivalent graphs (GATE4-1)
- [ ] `packages/workers/src/patterns/cross-scope.test.ts` — RED scaffold: CrossScopePatternDiscoveryWorker writes cross_domain_cluster_id (GATE4-2)
- [ ] `packages/gateway/src/routes/mcp.test.ts` — RED scaffold: MCP spawn_subtask + claim_next_task + complete_task round trip (GATE4-4)
- [ ] `packages/workers/src/scheduler/frontier.test.ts` — extend existing file: skill-match dispatch + no-skill passthrough test cases (GATE4-5)

*Note: `packages/control-plane/src/nesting.test.ts` (GATE4-3) is a new file created in Wave 2 by Plan 03-04, not a Wave 0 scaffold.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| MCP SSE push stream delivers `task_available` signal to a real SSE client | GATE4-4 | Requires live pg-listen + real SSE client connection | Connect SSE client to `GET /mcp/sse`, trigger a `task_spawned` event via `spawn_subtask`, observe signal arrives |
| `GET /.well-known/agent-card.json` returns correct AgentCard JSON | GATE4-4 | HTTP shape validation | `curl http://localhost:3000/.well-known/agent-card.json` → verify `protocol`, `version`, `skills` fields present |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references (GATE4-1, 4-2, 4-4, 4-5 scaffolds in Plan 03-01; GATE4-3 is Wave 2)
- [x] No watch-mode flags
- [x] Feedback latency < 30s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
