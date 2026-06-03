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

# Graph-Native Agent Runtime

A system for discovering reusable workflows from execution graphs. There is no workflow layer — what appears as a "workflow" is a statistical pattern that emerges from accumulated execution traces. The graph is the state; the context window is a projection of the graph.

## Project Context

- Domain docs: `Graph Engineering/CONTEXT.md` — canonical terminology glossary
- ADRs: `Graph Engineering/docs/adr/`
- RFC: `Graph Engineering/docs/RFC_v4.md`
- ADR overview: `Graph Engineering/docs/ADR_v4.md`

## Paradigm

- **No workflow layer** — there is no workflow engine, no DAG authoring, no pipeline definition. Workflows are discovered patterns, not designed components.
- **Context is a projection** — the context window is assembled per call from the graph's causal lineage; the graph is the permanent state. `Graph → Context`, never `Context = State`.
- **Workflow emergence** — recurring execution structures surface across superficially unrelated tasks (research, debug, design, planning share the same underlying topology). These become reusable patterns automatically.
- **LLM as graph navigator** — LLMs navigate accumulated execution traces; the system provides proven structures, the agent remains free to deviate. Deviations feed back into the graph.

## Key Domain Terms

- **Execution Graph** — SSOT; all workflows, memory, task branches are local topology of this graph; avoid: workflow graph, task graph
- **Entity** — logical object with stable UUID (Entity ID); avoid: node, object, record
- **Version** — immutable snapshot of Entity at a point in time, identified by SHA-256 content hash
- **Version Hash** — computed via `{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}`
- **Hyper-edge** — directed immutable edge `(N_source, N_target, event_type, version_hash, timestamp)`
- **Predecessor Hash** — prior version's hash, forming an append-only version chain
- **Workflow Emergence** — statistical patterns extracted from execution history that surface reusable structures across task types; not derived from existing workflows, not authored by humans
- **Cross-Domain Topology** — recurring graph structures (e.g. explore → hypothesize → validate → converge) that appear across unrelated task domains; visible only in the aggregate graph, invisible at the level of individual tasks
- **Cognitive Trace** — the full record of execution within a Scope, including successful paths, deviations, and conflicts; raw material for pattern discovery

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
