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
