---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: in_progress
last_updated: "2026-06-12T02:50:57.471Z"
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 6
  completed_plans: 6
  percent: 17
---

## Current Position

Phase: 16 (memexos-one) — COMPLETE; 1.0 candidate. Next: Phase 17
(mcp-connector-ecosystem, added to .harness/ROADMAP.md 2026-06-12) — MCP
catalog (optional-mcps/ manifests), OAuth PKCE + token cache via SDK
OAuthClientProvider, `memex mcp` CLI family, Claude Code / Hermes config
compatibility. Builds on Phase 6 McpClientWorker + Phase 16 skills-guard.
Phases 18–20 added 2026-06-12 (scenario-driven arc): 18 first-run-experience
(WSL2 live install + onboarding expansion + capability presets w/ meta-skills
+ live-leftovers), 19 console-and-artifacts (artifact graph convention +
UI-SPEC Console), 20 autonomous-assistant (agent self-install via approval,
ask_user tool, credential vault, sandboxed browser capability —
implementation-agnostic, bound via capability presets; tennis-court
north-star journey).

- Phases 10–16 completed across two autonomous sessions (9bb5035d → b92f686b).
  479 tests passing, tsc clean, red-line security tests green.

- Live-verified this session: Node-runtime gateway (REST+WS), containerized
  full-stack E2E (scope create + OCC write through 6 compose services),
  backup→restore→chain-verify cycle, 7-step eval journey ×2 (baseline +
  regression compare), SHA-256SUMS generate/verify.

- Canonical roadmap from Phase 7 onward: `.harness/ROADMAP.md`. Per-phase specs:
  `.planning/phases/NN-*/NN-PHASE-SPEC.md` (09–16).

- Remaining: live-environment items list in `.harness/implementation-notes.md`
  (Phase 16 section has the consolidated list).

## Last Session

- Timestamp: 2026-06-12T10:15:00.000Z
- Stopped At: Phase 15+16 complete (ADR-48/49); release gate defined and
  exercised; 1.0 candidate ready pending live-environment verification items.

- Resume File: .harness/state.json (single source of truth for position)

## Roadmap Evolution

- Phase 5 added: Architecture Hardening — LLM Provider registry+FallbackProvider, WebSocket/SSE stream API, @graph/types package, global config.json, SKILL.md progressive loading, CrystallizeWorker surgical distillation
- Phase 6 added: Gateway Seam Extraction — processAgentTurn, makeKnapsackGraph+makeKnapsackGraphFromView factories, knapsackSlice {kept,dropped}, KnapsackConfig
- 2026-06-11: Phases 12–16 product arc + tech debt ledger TD-A~M written into .harness/ROADMAP.md (19199ca9, af68fd2d); PHASE-SPECs 09–14 (7af8311d)
- 2026-06-12: .planning demoted to progress ledger; .harness/ROADMAP.md is canonical for Phase 7+
- 2026-06-12: Phases 18–20 scenario-driven arc added to .harness/ROADMAP.md (from 3-scenario gap analysis); browser automation pulled forward from post-1.0 into Phase 20 in containerized-worker-tool form only
- 2026-06-12: capability presets added to Phase 18 (capability category → user-chosen implementation: browser → vercel-labs/agent-browser, search → Tavily; meta-skills skills.sh/find-skill/create-skill installed by default); Phase 20 browser de-hardcoded from Playwright — isolation boundary is the invariant, implementation resolves via preset binding

## Decisions

- GATE4-1 tests same-label isomorphic graphs (not different-label) because WL kernel hashes event_type labels; different labels produce cosine < 0.90 for small 3-node graphs; same labels yield cosine = 1.0
- GATE4-2 uses pgvector unit-vector literals to guarantee threshold conditions without a real embedding provider
- triggerTaskId is not stored in scope_lineage (migration 005 has no column); caller passes it to resolveSubScope at child close time and it is embedded in sub_scope_resolved payload
- SUB_SCOPE_TOPIC exported from pulse-fetch.ts so Plan 03-06 imports identical string without duplication
- resolveSubScope falls back to ZERO_HASH if child partition has no events (defensive)
- wait_all_tasks uses polling loop (2s interval) not LISTEN/NOTIFY; stateless transport incompatible with persistent pg subscription
  (superseded in Phase 13: LISTEN-driven with 10s polling fallback)

- SDK import path is webStandardStreamableHttp.js not web.js (RESEARCH.md had wrong path)
- complete_task auto-resolves scope_id + predecessor_hash from ledger when not supplied (ergonomic for GATE4-4b)
- Stable UUIDs a1000000-0000-4000-8000-00000000000{1-7} assigned per internal Worker for agent_registry (D-2); coarse skill vocabulary; try/catch ensures boot failure does not crash Workers
- Phase 10–14 decisions: see ADR-50..56 (docs/adr/0050–0056) and .harness/implementation-notes.md

## Performance Metrics

| Phase | Plan | Duration (min) | Tasks | Files |
|-------|------|---------------|-------|-------|
| 03-pattern-discovery | 04 | 12 | 2 | 3 |
| 03-pattern-discovery | 05 | 25 | 3 | 5 |
| 03-pattern-discovery | 06 | 20 | 2 | 4 |
| 03-pattern-discovery | 07 | 25 | 2 | 2 |
