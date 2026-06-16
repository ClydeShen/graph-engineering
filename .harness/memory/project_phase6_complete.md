---
name: project-phase6-complete
description: "Phase 6 extensions complete — McpClientWorker, execute_bash, gateway-bot, UserProfileWorker, cryptographic pairing. 215 tests pass. All doc decisions recorded."
metadata: 
  node_type: memory
  type: project
  originSessionId: 90d3e1f6-9a76-4f7d-a817-eb8a348a8f4a
---

Phase 6 (06-extensions) verified complete as of 2026-06-09.

**What shipped:**
- T1 McpClientWorker — inbound MCP tool consumer, writes memory_updated hyper-edges
- T2 execute_bash — MCP tool with CommandGate safety gate, EXECUTE_BASH_ENABLED guard
- T3 gateway-bot — Telegram long-poll + Discord Ed25519 webhook; `dispatchMessage` writes task_spawned events
- T4 UserProfileWorker — 3AM cron; queries Crystal events; LLM synthesizes 3-5 bullet profile to USER_PROFILE_SCOPE_ID
- T5 cryptographic agent pairing — sha256+salt 8-char code, timingSafeEqual, TTL=3600, MAX_FAILED=5, per-request env guard
- T6 graph TUI — superseded (graph viz → MemexShell Dashboard, not standalone TUI)

**Key decisions (implementation-notes.md updated):**
- Discord is Ed25519 not HMAC-SHA256 (06-PLAN.md text was wrong)
- pairingGuard is per-request env check (not construction-time)
- pairing store is single-process in-memory Map (no cross-replica sync)
- dispatchMessage creates fresh UUID scope per message (production limitation — needs nestScope per session in prod)

**Test baseline:** 215 unit pass / 36 skipped (DB-gated) / 37 test files; tsc clean

**Why:** Phase 6 implemented to expand MemexCore from passive ledger to interactive multi-surface runtime.
**How to apply:** Phase 7 planning should reference this baseline. The 7 commits since last session (5aa50e5→db8c2b3) are all committed, tsc clean, and docs synced.

[[project_memex_terminal_naming]]
[[project_memex_final_product_is_hermes_like_e2e]]
