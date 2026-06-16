---
name: project_userprofile_partition_fix_and_journey
description: bootstrap user-profile scope fix (broken INSERT → idempotent partition DDL) + live multi-terminal journey all green + LLM now reachable
metadata: 
  node_type: memory
  type: project
  originSessionId: 1b828455-9fbe-42b6-8f59-cf1335f82cb5
---

2026-06-15. Triaged a console outage: gateway spammed `ECONNREFUSED 5432` because the
`graph-enginerring-postgres-1` container had Exited(255) (force-killed on shutdown, not a DB crash).
`docker start` restored it.

**Real fix shipped** (`packages/workers/src/boot/bootstrap.ts`): the "pre-create user-profile scope"
INSERT was dead code that failed every boot — it wrote the PARENT `execution_event_log`
(PARTITION BY LIST → no partition routed) with a non-canonical `scope_initialized` event_type the
CHECK constraint rejects; `ON CONFLICT DO NOTHING` never fired (error throws first). Also meant
`UserProfileWorker.occWrite` (targets the partition sub-table directly) would have failed too.
Replaced with idempotent partition DDL mirroring `nestScope()` Phase 1 (control-plane/src/nesting.ts):
`to_regclass` guard → `CREATE TABLE execution_event_log_scope_<nodash> PARTITION OF ... FOR VALUES IN`
+ uk_scope_occ_/uk_scope_idem_ constraints + pending-lookup index, for fixed USER_PROFILE_SCOPE_ID
`00000000-0000-4000-8000-000000000001`. Typecheck green. **NOT committed yet** (unstaged).

**Live multi-terminal journey** (user's def: subagent + background task simulating multiple terminals):
engine restarted via `npm run dev` (bg), 3 general-purpose subagents = 3 terminals, all PASS:
- A core graph: POST /v1/scopes 3-phase DDL; OCC won→demoted; `scripts/eval/journey.ts` 11 steps exit 0
- B observability: 8 console pages + 15 gateway read endpoints all 200; **ECONNREFUSED since boot = 0**
- C ops: `memex doctor` 0 fail 0 warn; hash-chain intact; user-profile partition + constraints confirmed

**LLM status FLIPPED — no longer BLOCKED.** doctor reports `nvidia: reachable` + embedding `BGE-M3 reachable`.
Supersedes the old "Gemini revoked / no Ollama" block in [[project_console_live_test_session]] and the
unverified residual in [[project_onboarding_provider_arc]]. Real LLM chat path now verifiable.

Docker cleanup done: `docker builder prune` reclaimed 1.33GB. Pending/unverified: orphan volume
`8b499f87…` (no container uses it, created 2026-06-05) and 6× `memexos-*` images (~1.5GB, rebuildable)
left in place — deletion deferred pending user confirmation on future containerized E2E.
