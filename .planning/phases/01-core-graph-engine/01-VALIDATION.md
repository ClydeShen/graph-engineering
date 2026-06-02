---
phase: 1
slug: core-graph-engine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-06-02
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (TypeScript unit) + pg integration tests |
| **Config file** | `vitest.config.ts` (Wave 0 installs) |
| **Quick run command** | `npm run test:unit` |
| **Full suite command** | `npm run test` |
| **Estimated runtime** | ~30 seconds (unit) / ~120 seconds (integration) |

---

## Sampling Rate

- **After every task commit:** Run `npm run test:unit`
- **After every plan wave:** Run `npm run test`
- **Before `/gsd:verify-work`:** Full suite must be green
- **Max feedback latency:** 30 seconds (unit), 120 seconds (integration)

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| canonical-json | 01 | 1 | REQ-03 | — | canonical_json produces same hash for same payload regardless of key insertion order | unit | `npm run test:unit -- canonical-json` | ❌ W0 | ⬜ pending |
| schema-migration | 01 | 1 | REQ-01, REQ-04, REQ-05 | — | execution_event_log UNIQUE constraint prevents duplicate predecessor_hash writes | integration | `npm run test:integration -- schema` | ❌ W0 | ⬜ pending |
| occ-writable-cte | 01 | 1 | REQ-01, REQ-02 | — | concurrent writes: first writer gets memory_updated, second gets conflict_detected in single transaction | integration | `npm run test:integration -- occ` | ❌ W0 | ⬜ pending |
| worker-lifecycle | 02 | 2 | REQ-12 | — | Worker state machine: no persistent write in Processing phase | unit | `npm run test:unit -- worker-lifecycle` | ❌ W0 | ⬜ pending |
| tool-boundary | 02 | 2 | REQ-11 | — | TypeScript compile fails when Tool calls write() | unit (tsc) | `npx tsc --noEmit` | ❌ W0 | ⬜ pending |
| gateway-validation | 03 | 2 | REQ-15, REQ-16 | — | Gateway returns 400 for invalid UUID format, never touches DB | unit | `npm run test:unit -- gateway` | ❌ W0 | ⬜ pending |
| pg-queue-adapter | 03 | 2 | REQ-17, REQ-18 | — | FOR UPDATE SKIP LOCKED dequeues events; ON CONFLICT DO NOTHING on re-delivery | integration | `npm run test:integration -- queue` | ❌ W0 | ⬜ pending |
| frontier-scheduler | 04 | 3 | REQ-19 | — | priority score formula: base×10 + age_bonus(≤20) + unlocks×5 + spawned_by_bonus(3) + active_bonus(15); no LLM call in dispatch path | unit | `npm run test:unit -- frontier` | ❌ W0 | ⬜ pending |
| context-assembly | 04 | 3 | REQ-20 | — | 3-layer prompt assembled; overflow truncates newest-last without LLM call | unit | `npm run test:unit -- context-assembly` | ❌ W0 | ⬜ pending |
| pattern-discovery-cron | 05 | 4 | REQ-22 | — | cron skips when completed_scope_count < 10; does not acquire OLTP worker slots | unit | `npm run test:unit -- pattern-discovery` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/__tests__/canonical-json.test.ts` — deterministic serialization unit tests
- [ ] `src/__tests__/worker-lifecycle.test.ts` — state machine unit tests
- [ ] `src/__tests__/tool-boundary.test.ts` — TypeScript compile enforcement test (via tsc --noEmit)
- [ ] `src/__tests__/gateway.test.ts` — Gateway Zod validation unit tests
- [ ] `src/__tests__/frontier.test.ts` — priority score formula unit tests
- [ ] `src/__tests__/context-assembly.test.ts` — 3-layer prompt assembly unit tests
- [ ] `src/__tests__/pattern-discovery.test.ts` — cron guard unit tests
- [ ] `tests/integration/schema.test.ts` — PostgreSQL schema integration tests (UNIQUE constraint, OCC)
- [ ] `tests/integration/occ.test.ts` — concurrent write OCC Writable CTE integration test
- [ ] `tests/integration/queue.test.ts` — PgQueueAdapter integration test
- [ ] `vitest.config.ts` — vitest configuration
- [ ] `package.json` test scripts: `test:unit` and `test:integration`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| iii Engine WebSocket connection established | REQ-06 | Requires running iii binary | Start iii engine, run Control Plane daemon, verify WebSocket handshake in logs |
| Wasm tokenizer loads in < 50ms | REQ-10 | Environment-dependent | Start Node.js process, measure `get_encoding('cl100k_base')` initialization time |
| Scope DDL nesting: partition created in PostgreSQL | REQ-07 | Requires PostgreSQL DDL permissions | POST /v1/scopes, query `pg_tables` for new partition |
| Convergence Watchdog emits scope_closed correctly | REQ-08 | Requires full system integration | Run complete Scope lifecycle with 2 tasks, verify `scope_closed` event in execution_event_log |
| Context OOM tier 3: context_oom_throttled written | REQ-09 | Requires W_max exhaustion scenario | Submit scope with W_max=100 tokens, verify `context_oom_throttled` event written |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s (unit) / 120s (integration)
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
