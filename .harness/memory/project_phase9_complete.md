---
name: project-phase9-complete
description: "Phase 9 (memory-layers) closed out 2026-06-11 — 4/4 plans, verified, CR-01 fixed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 0dbc65ca-dc6f-401c-bcac-14d1d1d84ea2
---

Phase 9 (memory-layers) is complete and verified (commit cb6a0269, 09-VERIFICATION.md status: passed).

- All 4 plans (09-01..09-04) merged: migration 012 (episodic/semantic/procedural tables + HNSW + ADR-43 provenance columns), TemplateProposalWorker (replaces EpisodicMemoryWorker), SemanticMemoryWorker supersession (>0.89 suggestedMerge), mem::reflect hybrid RRF retrieval + cold_start wiring into processAgentTurn.
- Code review found CR-01 (Critical): cold_start gate checked `episodic_memory` count which is always 0 for an open scope, so reflection fired every turn. Fixed in 4122a4db via `packages/shared/src/cold-start.ts` `isScopeColdStart()` (counts execution_event_log==1).
- IN-02 deferred (accepted, not a gap): `assemble.ts` `opts.memReflect.isColdStart`/`shouldReflect()` worker-pipeline path has zero production callers — only the gateway path (processAgentTurn) is wired. Revisit if/when worker-side reflection is needed.
- 283/283 tests passing, tsc clean. .harness/ROADMAP.md 09-01..04 marked [x].

**Why:** Phase 9 is the corpus production line for [[project_grilling_decisions_candidates_1_3]]-adjacent Phase 10 (trail-discovery) — Episodic/Procedural tables + BM25+HNSW retrieval are now live prerequisites.

**How to apply:** Phase 10 (trail-discovery) prerequisites are satisfied. Next planning step is `/gsd:discuss-phase 10` or `/gsd:plan-phase 10`. If asked about reflect/cold_start, the canonical signal is `isScopeColdStart` (packages/shared/src/cold-start.ts), not episodic_memory count.
