---
name: console-unifies-to-graph-projection
description: "Console architecture (multi-page dashboard) collapses entirely into 'graph projection + Connector' — confirmed 2026-06-07, supersedes the host-shell/plugin research thread"
metadata:
  node_type: memory
  type: project
  originSessionId: 34d8dadb-193c-4b05-9349-b6cfc1eb25a9
---

The "console architecture spike" (multi-page dashboard: graph view, system interaction/chat, task management, knowledge management, system settings) was found, through grounded cross-referencing against existing ADRs, to collapse into exactly **two already-locked architectural primitives** — meaning almost none of it requires new subsystem design:

1. **Graph projection** — every "page" (graph topology, task Kanban, knowledge wiki) is just a different `GET /v1/...` query that filters/shapes the same `execution_event_log` SSOT, identical in pattern to the existing `topology.ts` route. Task management = projection of Scope/Worker-job lifecycle events; Knowledge management = read-only projection of `entity_type=knowledge` entities (ADR 29's 4 subtypes: `skill`/`schema`/`plugin_doc`/`domain_fact`).
2. **Connector pattern (ADR 29 §4)** — every external information source (file uploads via chat attachments, Telegram messages, Gmail/Calendar integrations) funnels through the SAME already-designed pipeline: `Connector → external_trigger event → spawns Scope → Worker processes via tools → writes domain_fact Knowledge per ADR 36's locked per-tool-result write timing`. "Uploading reference materials" is NOT a separate feature — it's the system-interaction/chat page (with attachments) spawning a Scope, nothing more. "Integration Settings" = a UI over the Connector `install()`/`detect()` lifecycle that ADR 29 already specifies.

**Why this matters:** This directly validates [[reanchor-on-original-design-when-drifted]] — re-deriving from ADR 29/36 (not continuing to interrogate the drifted host-shell/plugin-manifest thread from the prior session) collapsed ~5 seemingly-independent subsystem-design questions into "write new projection-query routes on the existing `/v1/*` gateway, following the existing `topology.ts` pattern." The system's own foundational paradigm — "Context is a trail projection; Graph → Context, never Context = State" (CLAUDE.md) — turns out to apply recursively to the UI layer too: the console is just another `Graph → Projection` consumer.

**How to apply:** When designing any new console page or feature, first ask "is this a read-projection of existing graph entities, or a trigger that spawns a Scope/writes via Connector?" — almost everything is one of these two. Only escalate to "needs new architecture" when something genuinely cannot be expressed as either (the one confirmed exception found so far — LLM model/provider settings — has since been resolved; see below).

**Resolved exception (2026-06-08):** "LLM model settings" — the one item that didn't fit the projection/Connector frame — is now fully converged: **writable**, but scoped tightly enough to stay zero-conflict with the existing architecture. Final design (written into `docs/UI-SPEC.md`'s new "Phase 4+ 设计基线" section):
- Persisted to an **independent JSON/YAML config file** (not `.env` — can't persist UI input; not graph — would put API keys in the immutable execution trail; not `iii-config.yaml` — verified it carries zero LLM fields, contradicting its own docstring)
- Shaped as **single chat-slot + separate embedding axis** `{ chat: {...}, embedding: {...} }` — explicitly NOT hermes's primary/secondary multi-tier (no evidence Memex's async graph-execution workload has the latency-driven bimodal shape that justifies it; see [[value-vs-type-change-cost]] for how the cost estimate that almost blocked this got corrected)
- **Gateway applies changes immediately** (in-process mutation — the provider re-reads its config fresh per call, so this is ~10 lines); **workers process applies on next natural restart** (no new hot-reload infra — this aligns with, not compromises, the system's existing immutability guarantee)
- "Soft restart" was proposed to smooth the workers-side delay and explicitly **rejected/decoupled** — it would reopen the already-disabled, judged-incomplete `iii-exec` design (`iii-config.yaml:37-48`, see `.harness/analysis/uat-journey-2026-06-07.md`), a separate and much larger infrastructure problem with its own history

This closed the LAST open structural question — the console design space is now considered structurally complete.
