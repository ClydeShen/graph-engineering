# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

    1. [Step] → verify: [check]
    2. [Step] → verify: [check]
    3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Harness Discipline

**Long-running work fails silently. Epistemic gaps compound into errors. Make both kinds of boundary explicit.**

- Don't fabricate. Every factual claim must trace to observed evidence, documentation, or established best practice. Confidence is not a source — if you cannot ground a claim, say so rather than presenting it as fact.
- It's OK not to know. Say so explicitly instead of guessing. Proactively surface information gaps and ask what you need to proceed — don't fill them with plausible-sounding assumptions.
- While implementing a spec, maintain a running `.harness/implementation-notes.md` capturing: decisions made that weren't covered by the spec, things that had to change from the original plan, tradeoffs you made, and anything else the human should know.
- Exit criteria must be observable: a gate that passed, not a feeling that it's done. Name the anti-patterns: Fuzzy Done, Proxy Signal, Confidence Exit.
- State lives outside the agent. The source of truth is the issue tracker, the handoff document, the config file — not working memory.

## 6. Long-Task Checkpointing

**Checkpoint after every committed chunk.**

For multi-step tasks spanning more than one commit:

- Write progress to `.harness/state.json` (`position.stopped_at`) after each chunk completes.
- Commit the checkpoint alongside the work — never leave state and code out of sync.
- If interrupted, the next session reads the checkpoint and resumes from the last known-good commit.

Do not run long autonomous loops without a checkpoint strategy.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, clarifying questions come before implementation rather than after mistakes, and long-running sessions hand off cleanly without lost context.

# Memex — Graph-Native Agent Runtime

> "The human mind operates by association. With one item in its grasp, it snaps instantly to the next that is suggested by the association of thoughts, in accordance with some intricate web of trails carried by the cells of the brain."
> — Vannevar Bush, *As We May Think* (1945)

A system for discovering reusable workflows from execution graphs. There is no workflow layer — what appears as a "workflow" is a statistical pattern that emerges from accumulated trails. The Trail Mesh is the permanent record; the context window is a projection of the graph.

## Memex Foundation

Vannevar Bush proposed the Memex in 1945: a device to extend human memory through *associative trails* rather than hierarchical indexes. The human mind, he observed, doesn't index — it associates. One thought snaps to the next through a web of connections forged by experience.

This system operationalizes that idea for AI agents. The mapping is direct:

| Bush's Memex (1945) | This System |
|---|---|
| Memex device | The runtime itself — externalized cognitive memory |
| Trail | Cognitive Trace — full execution record including deviations |
| Association | Hyper-edge — directed, immutable link between entities |
| Item | Entity — addressable knowledge unit with stable UUID |
| Trail blazing | Writing hyper-edges; connecting entities across time |
| Trail Mesh | Execution Graph — aggregate of all trails, SSOT |
| Shared trail | Emerged workflow pattern — reusable graph topology |
| Compression | Crystallization — LLM distillation of trails into Lessons |

One extension beyond Bush: this system is not passive. It actively crystallizes raw trails into durable Lessons and reinforces them on an Ebbinghaus confidence schedule. The Memex doesn't just record — it learns.

## Paradigm

- **No workflow layer** — there is no workflow engine, no DAG authoring, no pipeline definition. Workflows are discovered trails, not designed components.
- **Context is a trail projection** — the context window is assembled per call from the graph's causal lineage; the Trail Mesh is the permanent record. `Graph → Context`, never `Context = State`.
- **Trail emergence** — recurring execution structures surface across superficially unrelated tasks (research, debug, design, planning share the same underlying topology). These become reusable patterns automatically.
- **LLM as trail navigator** — LLMs navigate accumulated trails; the system provides proven structures, the agent remains free to deviate. Deviations are recorded and feed back into the Trail Mesh.
- **Trails include deviations** — failures, retries, and conflicts are first-class trail data. A trail that always deviates at the same point is signal, not noise.

## Key Domain Terms

Memex vocabulary is the primary naming layer. Implementation identifiers (where different) follow in parentheses — existing stable names are grandfathered and not force-renamed.

- **Trail** (`CognitiveTrace`) — full execution record within a Scope, including deviations and conflicts; Bush's associative trail; raw material for pattern discovery
- **Association** (`HyperEdge`) — directed immutable link `(source, target, event_type, version_hash, timestamp)`; atomic unit of connection in the Trail Mesh
- **Entity** (`Item`) — logical object with stable UUID; addressable across all trails that touched it; avoid: node, object, record
- **Snapshot** (`Version`) — immutable state of an Entity at a point in time; identified by SHA-256 content hash
- **Trail Mesh** (`ExecutionGraph`) — aggregate of all Trails and Associations; SSOT; avoid: workflow graph, task graph
- **Crystallization** — LLM distillation of a raw Trail into a durable Lesson on scope close; output of CrystallizeWorker
- **Lesson** — extracted insight from Crystallization; confidence-weighted, reinforced by Ebbinghaus schedule
- **Trail Discovery** (`WorkflowEmergence`) — statistical pattern extraction from Trail Mesh history; not authored, not designed — observed
- **Cross-Domain Topology** — recurring Trail structures (e.g. explore → hypothesize → validate → converge) visible only in aggregate, invisible at the level of individual trails
- **Version Hash** — computed via `{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}`
- **Predecessor Hash** — prior Snapshot's hash; forms the append-only Association chain

## Naming in New Code

When writing new code (Phase 5+), prefer Memex vocabulary:

- **Event type strings** — use `memex::` prefix for new event types (e.g., `memex::lesson::save`, `memex::trail::crystallize`); existing `graph::*` strings are grandfathered
- **Type and interface names** — prefer `Trail`, `Association`, `Lesson`, `Crystallization` as primary names in new modules
- **Worker names** — describe their role in the trail lifecycle (e.g., a worker that marks lessons is a "waypoint" in trail terms)
- **Comments** — use Memex terms; put implementation aliases in parentheses

Do not rename existing stable identifiers (DB column names, established event strings, existing type exports) — migration cost exceeds value. New surfaces only.

## Project Context

- Domain docs: `Graph Engineering/CONTEXT.md` — canonical terminology glossary
- ADRs: `Graph Engineering/docs/adr/`
- RFC: `Graph Engineering/docs/RFC_v4.md`
- ADR overview: `Graph Engineering/docs/ADR_v4.md`

## Harness

- Issue tracker: GitHub Issues (`ClydeShen/graph-enginerring`)
- State: `.harness/state.json`
- Phases: `.harness/phases/`
- Project context: `.harness/PROJECT.md`
- Roadmap: `.harness/ROADMAP.md`

## Conventions

- Language: English for code, Chinese acceptable in domain docs
- Immutable append-only writes — no updates to existing graph nodes
- PostgreSQL (pgcrypto) for hash computation
- Loop regression gate: before changing any emergence-loop asset (crystallization /
  merge / recall prompts or SQL in `template-proposal.worker.ts`, `reflect.function.ts`,
  `memory-repository.ts`) or swapping the LLM model, run `npm run eval:loop`. Unit tests
  cannot catch loop regressions — they are behavioral. See `scripts/eval/README.md`.
