# Requirements: Graph-Native Agent Runtime

> Scope: MVP (Phase 1) + full system (Phases 2–4). MVP requirements are marked **[MVP]**.

---

## Functional Requirements

### F1 — Execution Graph (Append-Only Event Log)

**F1.1** [MVP] The system SHALL maintain a single `execution_event_log` table as the SSOT for all agent execution state. No in-place updates; every state change appends a new row.

**F1.2** [MVP] Every row SHALL have:
- `entity_id` (UUIDv4) — stable identity across versions
- `version_hash` (SHA-256 hex, 64 chars) — cryptographic content address, computed by pgcrypto `digest()` in-transaction
- `predecessor_hash` — points to the immediately preceding version; NULL only for `plan_created` root nodes
- `event_type` — one of: `plan_created`, `task_spawned`, `memory_updated`, `conflict_detected`, `scope_closed`
- `scope_id` — cryptographic salt, mandatory on every row
- `payload` (JSONB) — event-specific data

**F1.3** [MVP] The `version_hash` SHALL be computed as:
```
SHA-256( "{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}" )
```
`canonical_json(payload)` MUST be computed in the **application layer** (TypeScript/Rust) via recursive BTreeMap key-sort before the INSERT. PostgreSQL receives the pre-normalized TEXT constant and computes `digest(content_input, 'sha256')` (pgcrypto) inside the transaction. **NEVER** use `payload::jsonb::text` inside PostgreSQL — jsonb does NOT guarantee alphabetical key order (ADR 02 correction, 2026-05-31).

**F1.4** [MVP] The system SHALL enforce `UNIQUE(predecessor_hash, scope_id)` as the OCC physical lock. No application-layer check-then-insert.

**F1.5** The system SHALL support LIST partitioning of `execution_event_log` by `scope_id` (Phase 2+). MVP uses a single unpartitioned table.

---

### F2 — Optimistic Concurrency Control (OCC)

**F2.1** [MVP] When two Workers attempt to write to the same `predecessor_hash` concurrently, the system SHALL resolve the conflict atomically in a single Writable CTE round-trip:
- First writer → `event_type = 'memory_updated'` (winner)
- Later writer → `event_type = 'conflict_detected'` (demoted), `predecessor_hash` rewritten to point at the winner's `version_hash` (causal inversion)

**F2.2** [MVP] The CTE SHALL recompute `version_hash` for the demoted row based on its post-inversion content, inside the same transaction.

**F2.3** [MVP] The CTE SHALL return `won` or `demoted` to the calling application. Workers MUST NOT retry; `demoted` is a normal terminal outcome.

**F2.4** [MVP] `conflict_detected` rows SHALL retain `actual_basis_hash` in `payload` (the original predecessor the loser intended to build on).

---

### F3 — Event Bus (iii Engine + Control Plane Daemon)

> **Architecture correction (2026-06-01, ctx7 verified):** The event bus is provided by the pre-installed **iii Engine binary** (`npm install iii-sdk` for SDK; engine installed via `curl -fsSL https://install.iii.dev/iii/main/install.sh | sh`). The **Control Plane Daemon** (our TypeScript code) bridges PostgreSQL LISTEN/NOTIFY → `iii.trigger()`. We do NOT build a Rust event bus.

**F3.1** [MVP] A PostgreSQL `AFTER INSERT` trigger on `execution_event_log` SHALL fire `pg_notify('iii_engine_channel', '{"id":N}')` with a ≤64-byte JSON pulse (ADR 09).

**F3.2** [MVP] The **Control Plane Daemon** (TypeScript, `pg-listen`) SHALL maintain a LISTEN connection that is never inside an open transaction. Boot sequence: subscribe → read HWM from `bus_state` → consume notifications.

**F3.3** [MVP] The Control Plane Daemon SHALL maintain `bus_state.last_processed_event_id` (HWM). On reconnect, it SHALL replay all `event_id > HWM` before resuming LISTEN mode (ADR 08/09).

**F3.4** [MVP] The Control Plane Daemon SHALL route events to Workers by calling `iii.trigger({ function_id: 'worker::${event_type}', payload: event })`. iii Engine handles WebSocket delivery to the registered Worker function (ADR 09).

**F3.5** [MVP] Workers SHALL connect to iii Engine via `registerWorker(III_URL)` and register functions via `registerFunction(id, handler)`. Workers SHALL re-register on reconnect.

**F3.6** The iii Engine manages internal Worker subscriptions via its own DashMap. The Control Plane Daemon SHALL NOT attempt to directly modify iii Engine's internal routing state.

---

### F4 — ConflictResolverWorker (TypeScript)

**F4.1** [MVP] The Worker SHALL subscribe to `event_type == "conflict_detected"` events.

**F4.2** [MVP] On receiving a `conflict_detected` event, the Worker SHALL:
1. Read both the winning branch (`legitimate_basis_hash`) and the demoted branch from `execution_event_log`
2. Construct a Topological Horizon context slice (capped at `min(2000, W_max × 0.3)` tokens for reflection memory)
3. Call Claude API with `tool_choice: { type: "tool", name: "emit_convergence_gate" }` to force structured output
4. Validate the tool `input` with Zod before writing to PostgreSQL

**F4.3** [MVP] The convergence node SHALL be a `memory_updated` INSERT with:
- `predecessor_hash` pointing to the winner's `version_hash`
- `payload.convergence_gate` containing: `legitimate_basis_hash`, `conflicted_basis_hash`, `clash_scope_root_hash`

**F4.4** [MVP] The Worker SHALL NOT write the convergence node if Zod validation fails. It SHALL log the failure and emit a diagnostic event.

---

### F5 — Procedural Memory (Cold-Start Retrieval)

**F5.1** [MVP] The system SHALL maintain a `procedural_memory` table with:
- `template_graph` (JSONB) — skeleton graph for Skeleton Graph bootstrap
- `is_anti_pattern` (boolean) — separates positive/negative samples
- `embedding` (vector) — for HNSW ANN search
- `ts_tokens` (tsvector) — for BM25 full-text search
- `quality_score` (float), `created_at` (timestamp)

**F5.2** [MVP] A stored procedure SHALL implement two-phase RRF hybrid retrieval:
1. Phase 1: Vector ANN top-20 via HNSW (`<=>` cosine distance)
2. Phase 2: Re-rank with `cosine_sim × 0.6 + quality_score × 0.3 + recency × 0.1`
3. Return top-3 results

**F5.3** [MVP] `tsvector` tokenization SHALL use `'simple'` dictionary. The system SHALL NOT use `'simple'` for Chinese-language content without a supplementary tokenization strategy (e.g., pre-tokenize with a Rust/TS jieba wrapper before INSERT).

**F5.4** Full four-layer memory (Episodic + Semantic with `superseded_by` knowledge version chain + 30-day Ebbinghaus decay) is deferred to Phase 2.

---

### F6 — Schema Integrity & Bus Contract

**F6.1** [MVP] The PostgreSQL schema SHALL be managed via versioned migration files (e.g., `migrations/001_initial.sql`).

**F6.2** [MVP] Worker data-plane DB account SHALL have `SELECT` + `INSERT` only. DDL permissions belong to the control-plane account exclusively.

**F6.3** The event bus SHALL reject any event whose `event_type` is not in the five canonical types (Phase 2+). MVP: enforce at application layer.

---

## Non-Functional Requirements

### NF1 — OCC Correctness
Under concurrent writes from N Workers to the same `predecessor_hash`, exactly one row SHALL have `event_type = 'memory_updated'` with that predecessor. All others SHALL be `conflict_detected`. No `UNIQUE` constraint violations SHALL propagate to the application as errors.

### NF2 — Delivery Guarantee
After iii-engine reconnect, no events with `event_id > HWM` SHALL be silently dropped. Delivery is at-least-once; Workers MUST be idempotent on duplicate event delivery.

### NF3 — Token Budget
Workers SHALL compute `W_max = W_physical - W_system_prompt - Δ_padding` before constructing prompts. Reflection memory SHALL never exceed `min(2000, W_max × 0.3)` tokens.

### NF4 — Auditability
Every graph node SHALL be reconstructible from the append-only log alone. No out-of-band mutable state SHALL be required to explain the current graph topology.

### NF5 — Chinese Content
Full-text search on Chinese-language content in `procedural_memory` SHALL NOT silently return empty result sets. Either pre-tokenize (jieba) or document the limitation explicitly.

### NF6 — Cross-Platform Support
The system SHALL run without modification on Windows 11, macOS, and Linux. Specific constraints:

**NF6.1** Pi Agent spawn in TypeScript Workers SHALL use `{ shell: true }` (or equivalent platform abstraction) so that `pi` resolves correctly on Windows (where npm global installs create `.cmd` wrappers) and on macOS/Linux.

**NF6.2** All `iii-exec` `exec` command strings in `config.yaml` SHALL use cross-platform syntax (Node.js invocations only; no `sh -c` or `cmd /C` idioms in the project-owned commands themselves). The iii engine applies the correct shell wrapper per platform.

**NF6.3** All filesystem paths in `config.yaml`, Worker manifests, and migration scripts SHALL use POSIX-style forward slashes (`./workers/…`). iii normalizes paths cross-platform.

**NF6.4** The `iii` engine binary installation SHALL be documented for all three platforms. The curl install script (`https://install.iii.dev/iii/main/install.sh`) works on macOS/Linux; a PowerShell or Docker alternative SHALL be provided for Windows.

**NF6.5** The Rust crate (`crates/iii-engine/`) SHALL compile and pass tests on all three platforms via `cargo test`. No platform-specific FFI or OS APIs without conditional compilation guards.

---

## Out of Scope (MVP)

- Dynamic Scope LIST partitioning (ADR 04)
- Three-phase nest protocol / DDL control plane (ADR 05)
- Wasm tokenizer sidecar (ADR 15)
- Episodic memory table + HNSW (Phase 2)
- Semantic memory versioned knowledge chain (Phase 2)
- Δ_padding adaptive widening (Phase 3)
- Multi-machine CDC / iii-engine clustering (Phase 4)
- Pi sandbox pre-execution simulation (ISSUE-28)
