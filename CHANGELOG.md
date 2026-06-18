# Changelog

All notable changes to MemexOS. Format: [Keep a Changelog](https://keepachangelog.com/);
versioning: semver from 1.0.0 (single version source: root `package.json`).

## [Unreleased] — 1.0.0 candidate

### Added — Freshness substrate: the loop's restoring force (GH #30–#35; branch `feat/freshness-substrate`)
- Deterministic conformance comparator (`conformance.ts`) — DAG-vs-prescribed-rules judge (no second LLM): a non-convergent scope softens only the crystallizations whose order it actually followed (ingredient at fault); rule-violating failures are composition's fault (out of scope). The automatic de-confounder.
- Per-template conformance-gated soften + token-efficiency-graded harden; three-band metabolism (evidence-gated apoptosis + 90d atrophy; ambiguous middle → human triage, never silent; reversible reinstate)
- Mid-flight escalation gate: `memReflect` returns per-template trust; a plan on shaky ingredients surfaces a sparse verification report (`context.verificationReport`)
- Recency-weighted retirement (`recent_quality` EWMA, migration 023) — fixes "late drift" of a once-good template; grounded in non-stationary-bandit theory (discounted UCB)
- Human triage/edit surface: `/v1/memory/triage|feedback|retire|reinstate` + console **Review** page (built with ui-ux-pro-max)
- All calibration constants externalized in `freshness-config.ts`; statistical multi-curve **collapse-rate** loop gate (single-curve absolute thresholds can't separate a bad draw from a regression on a bimodal loop)
- Falsified end-to-end: substrate cut the §5 collapse-rate from a ~0.55 baseline to 0.33 and the metabolism was shown live escaping the collapse attractor (paper §5.8)

### Added — Phase 16 (memexos-one)
- `memex skills search/install/inspect` — dual-registry (agentskills.io/ClawHub) install side with skills-guard injection scan (review aid; findings withhold install until confirmed)
- Eval harness: `scripts/eval/journey.ts` (7-step asserted E2E) + quality metrics (trail-discovery hit rate, lesson retention, knapsack compression) + snapshot regression gate
- Release integrity: `SHA-256SUMS` generation/verification over the frozen artifact list
- `memex --version`; `SECURITY.md` (trust model + disclosure policy); `docs/QUICKSTART.md`

### Added — Phase 15 (deploy-everywhere)
- One-line installers: `scripts/install.sh` (POSIX) + `scripts/install.ps1` (Windows)
- Docker deployment: `deploy/Dockerfile` (Node 22 single base + iii engine) + 6-service compose + hardened override (internal/egress networks, cap-drop, no-new-privileges)
- `memex doctor` — 8 diagnostic checks incl. sampled hash-chain verification with the erased_at rule
- `memex backup`/`restore` (pg_dump -Fc) with post-restore chain gate; `memex service` generators (systemd/launchd/schtasks)
- Profiles: `MEMEX_PROFILE` → `~/.memex/profiles/<name>/`, per-profile `database.url`
- Gateway runs on Node 22 (TD-M closed); Bun kept as compatibility branch; cross-replica pairing read-through (TD-G closed)

### Added — Phases 9–14 (single development arc)
- Memory layers: episodic/semantic/procedural with hybrid BM25+HNSW retrieval, Ebbinghaus reinforcement, cold-start reflect
- Trail Discovery: canonical template graphs (WL refinement), template proposal/injection/reinforcement loop, 3-signal rerank, anti-patterns
- Memex Shell: realtime WS/SSE API (ADR-44), onboarding TUI, MemexTerminal client, dashboard live view, frozen ConnectorAdapter contract
- Connector matrix: Telegram/Discord/Slack (zero-SDK)/Email/Webhook (HMAC mandatory), graph-native cron (ADR-45), DeliveryRouter
- Agent federation: visibility domains enforced across all retrieval routes, conflict attribution, advisory candidate ranking, cycle detection (ADR-46)
- Trust isolation: erase(scope) workflow, cross-channel approval state machine (silence=deny), env/PII filtering, trust→toolset enforcement, docker exec hardening (ADR-47)

[Unreleased]: https://github.com/ClydeShen/graph-enginerring/commits/master
