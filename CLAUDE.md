# Graph-Native Agent Runtime

Graph-native agent runtime system. Immutable event graph as single source of truth, decentralized event bus driving multi-agent collaboration, blockchain-ledger philosophy for tamper-proof state and adaptive evolution.

## Project Context

- Domain docs: `Graph Engineering/CONTEXT.md` — canonical terminology glossary
- ADRs: `Graph Engineering/docs/adr/`
- RFC: `Graph Engineering/docs/RFC_v4.md`
- ADR overview: `Graph Engineering/docs/ADR_v4.md`

## Key Domain Terms

- **Execution Graph** — SSOT; all workflows, memory, task branches are local topology of this graph
- **Entity** — logical object with stable UUID (Entity ID); avoid: node, object, record
- **Version** — immutable snapshot of Entity at a point in time, identified by SHA-256 content hash
- **Version Hash** — computed via `{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}`
- **Hyper-edge** — directed immutable edge `(N_source, N_target, event_type, version_hash, timestamp)`
- **Predecessor Hash** — prior version's hash, forming a blockchain-style chain

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
