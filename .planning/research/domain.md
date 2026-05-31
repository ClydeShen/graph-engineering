# Domain Research: Graph-Native Agent Runtime

> Research basis: project artifacts (RFC_v4, ADR_v4, CONTEXT.md, ADR 20 supplement),
> practitioner knowledge of event-sourced systems, PostgreSQL internals, and agent
> orchestration ecosystems. Web search was unavailable during this session; findings
> draw on training data current to August 2025 and in-repo design decisions.

---

## 1. Comparable Systems

### 1.1 LangGraph

**What it gets right:**
- Graph-as-control-flow is the right abstraction for multi-step agent reasoning. Practitioners
  find DAG-based orchestration more debuggable than linear chain-of-thought.
- Checkpointing via LangSmith allows replay from any prior node — closest analog to
  predecessor_hash chains in this system.
- First-class support for human-in-the-loop interrupts between nodes.

**What it gets wrong vs. an append-only graph model:**
- State is mutable at rest. LangGraph checkpoints are snapshots, not an immutable ledger.
  A bug that corrupts state at step N destroys the ground truth; there is no cryptographic
  proof of what happened.
- Concurrency model is application-layer locks, not database-layer OCC. Multi-agent fan-out
  with shared state requires explicit developer plumbing; race conditions surface in
  production rather than being resolved atomically at the database layer.
- Workflows are code-defined. Refactoring the graph means refactoring Python classes.
  There is no equivalent to Skeleton Graph bootstrap (procedural_memory template_graph).
- LangGraph's persistence backend (SQLite/Postgres) stores serialized state blobs, not
  events. You cannot reconstruct the causal chain of *why* the graph arrived at a state
  without reading application logs — a different artifact from the state store.

**Net assessment:** LangGraph is a thin orchestration shim over LLM calls with checkpointing
bolted on. The graph-native runtime is architecturally deeper: the graph IS the ledger,
the control flow, and the audit trail simultaneously.

---

### 1.2 Temporal.io

**What it gets right:**
- Durable execution is the central primitive. Temporal's event history is append-only and
  replayed to reconstruct workflow state — philosophically identical to this system's
  execution_event_log.
- Workflow code is deterministic-replay-safe. Workers are stateless; all state lives in
  the event history. This is the correct mental model.
- Activity retries, timeouts, and signals are first-class. Production-hardened at scale
  (Uber, Snap, Netflix).

**What it gets wrong vs. an append-only graph model:**
- The unit of durability is a workflow function, not a graph. Two concurrent workflows
  touching shared entities have no cross-workflow OCC — the developer must coordinate
  via signals/queries, which is error-prone.
- No native semantic memory layer. Long-running agents must implement memory retrieval
  externally, producing a split between the durable state store (Temporal) and the
  memory store (Pinecone/pgvector/etc). This system unifies both in one PostgreSQL SSOT.
- Replay storms on large histories are a known production issue. Temporal recommends
  ContinueAsNew to truncate history after ~10k events per workflow. This system's
  scope-partitioned tables + snapshot+incremental strategy (ADR 07) avoids this
  architectural ceiling without loss of history.
- Event schema is Temporal-specific Protobuf. No cryptographic content-addressing;
  events are identified by sequence number only, not content hash.

**Net assessment:** Temporal solves durable execution extremely well for workflow automation.
It does not solve the agent memory problem or multi-agent graph topology in one primitive.

---

### 1.3 EventStoreDB

**What it gets right:**
- Purpose-built append-only event log. Streams map naturally to entity version chains.
  Optimistic concurrency via `expectedVersion` on stream appends — structurally identical
  in intent to `UNIQUE(predecessor_hash, scope_id)`.
- First-class projections (Catch-Up Subscriptions, Persistent Subscriptions) feed read
  models without polling.
- Guaranteed ordering per stream.

**What it gets wrong vs. this system:**
- No native vector search. Memory retrieval requires an external vector store, splitting
  the SSOT.
- `expectedVersion` OCC is stream-scoped, not content-addressed. Two writes with the
  same content in the same stream at different times get different version numbers but
  are indistinguishable by hash. This system's scope-salted SHA-256 version_hash
  provides cryptographic tamper evidence EventStoreDB lacks.
- SQL query plane requires projecting to a relational read model. Hybrid retrieval
  (HNSW + BM25 RRF) is not possible without an external system.
- Cross-stream transactionality is limited. Coordinating multiple entity streams in one
  atomic operation requires careful idempotency handling the developer must implement.

**Net assessment:** EventStoreDB is the closest architectural analog in the traditional
event sourcing world. The main gap is memory unification and content-addressed identity.

---

### 1.4 Apache Kafka + Flink (as agent orchestration backend)

**What it gets right:**
- Massive throughput. For fan-out workloads where thousands of concurrent agent tasks
  are generating events, Kafka's partitioned log is operationally proven.
- Flink's stateful stream processing enables complex event pattern detection
  (equivalent to convergence watchdog logic).

**What it gets wrong vs. this system:**
- Kafka topics are not a content-addressed graph. You cannot traverse predecessor_hash
  chains; you can only scan by offset. There is no native OCC mechanism — duplicate
  processing requires idempotency keys managed by the application.
- Kafka + Flink is a data pipeline system, not an agent runtime. Implementing
  the equivalent of Knapsack Slicing, Topological Horizon, and Scope lifecycle
  management on top of Kafka requires building the entire control plane from scratch.
- Infrastructure cost and operational complexity are high. For the workload profile
  of an agent runtime (moderate event rate, high semantic richness per event),
  PostgreSQL BIGSERIAL + LISTEN/NOTIFY delivers equivalent ordering guarantees with
  dramatically lower operational burden.
- No built-in memory layer. Same SSOT fragmentation problem as Temporal.

**Net assessment:** Kafka/Flink is a poor fit. The throughput ceiling of this system's
PostgreSQL-native approach is sufficient for agent workloads; the operational cost
delta is not justified.

---

### 1.5 Reduct (and similar append-only time-series event stores)

**What it gets right:**
- Append-only, time-indexed blob storage with labeling. Used in robotics/IoT for
  sensor stream replay.
- Efficient sequential access.

**What it gets wrong:**
- No relational query plane, no vector search, no OCC, no content-addressing.
  Not designed for LLM agent state. Mentioned here only because the append-only
  philosophy is shared; the use case is entirely different.

---

## 2. Event Sourcing + CQRS in Agent/Workflow Systems — Failure Modes at Scale

### 2.1 Replay Storm
**What it is:** On system restart or consumer reconnect, naive implementations replay all
events from the beginning of the log. At millions of events, this causes multi-minute
startup delays and hammers the event store.

**How it manifests:** A bug fix requires a consumer restart. The restart triggers a full
replay. Other consumers are starved of I/O bandwidth. SLA breach.

**This system's mitigation:** ADR 07 (scope-partitioned snapshots + incremental replay from
HWM). ADR 08 (HWM-based catchup: `WHERE id > last_processed_event_id`). The replay
boundary is scoped to a single partition, not the full table.

**Residual risk:** Snapshot staleness. If a scope snapshot was written at event 500 and
the scope has 10,000 events, cold rebuild still replays 9,500 events. Snapshot cadence
policy is not defined in the ADRs.

---

### 2.2 Event Schema Evolution
**What it is:** Over time, event payload schemas change. Old events written with schema v1
must be processed by code expecting schema v2.

**How it manifests:** Adding a required field to `memory_updated` payload breaks all
historical event replay. Removing a field silently drops data that old consumers still
read.

**Industry practice:** Maintain backward-compatible schemas (Avro, Protobuf with field
numbers, or JSON Schema with additionalProperties allowed). Use upcasters at read time
rather than mutating stored events.

**This system's risk:** The RFC defines `canonical_json(payload)` as the hash input.
Any schema change that alters key ordering or adds/removes fields will produce different
hashes for semantically identical payloads. Upcasting must happen *before* hash
verification or the chain appears corrupt. This is not addressed in current ADRs.

---

### 2.3 Projection Divergence
**What it is:** The read model (projected view) drifts from the event log because a
projection bug was deployed and ran for hours before detection. The event log is correct;
the projection is wrong.

**How it manifests:** Queries against the read model return stale or incorrect data.
Because the projection is the fast path, the bug is only found when someone manually
queries the raw event log.

**This system's context:** The in-memory hot graph (ADR 07) is a projection. If a bug in
the projection logic runs against live events, the hot graph will be wrong. Since Workers
read the hot graph for Topological Horizon computation, LLM context will be wrong.

**Mitigation practice:** Projections must be fully rebuildable from the event log at any
time. Test projection rebuild on every deployment. Add a checksum comparison between
hot graph state and a fresh rebuild on startup.

---

### 2.4 Causality Violation via Out-of-Order Event Delivery
**What it is:** The event bus delivers events to consumers out of insertion order.
Consumer A processes event 102 before event 101. Consumer builds a projection where
a child node exists before its parent.

**How it manifests:** Knapsack Slicing traverses predecessor_hash chain and encounters
a node whose predecessor is not yet in the hot graph. The DAG slice is incomplete.
The LLM receives a context that is missing critical causal ancestry.

**This system's mitigation:** ADR 09 (LISTEN/NOTIFY Pulse-Fetch with BIGSERIAL ordering).
The `id > last_processed_event_id` fetch order enforces monotonic consumption.

**Residual risk:** If two Workers write events with consecutive BIGSERIAL IDs and the
second commit completes before the first (possible under high concurrency), the HWM
can advance past the first event before it is visible to the NOTIFY consumer. This
is the "visibility gap" problem in PostgreSQL. Mitigation: add a short read-committed
delay or use `pg_current_xact_id()` watermarking.

---

### 2.5 OCC Contention Spiral
**What it is:** Under high concurrency, many Workers attempt to write to the same
predecessor_hash. One wins; all others become `conflict_detected`. ConflictResolverWorkers
are spawned for each. Each resolver writes a new convergence node, which itself can
conflict with other in-flight resolvers.

**How it manifests:** A single hot entity generates an exponential fan of conflict
resolution tasks, saturating the ConflictResolverWorker pool.

**This system's mitigation:** The Convergence Gate (Convergence Door payload with
`legitimate_basis_hash` + `conflicted_basis_hash`) provides a bounded resolution
structure. The watchdog's three-tier defense prevents premature scope close.

**Residual risk:** No explicit back-pressure mechanism on ConflictResolverWorker
spawning is visible in the ADRs. A pathological workload (10 Workers all updating
the same entity simultaneously) could produce O(n) concurrent resolver instances.

---

## 3. OCC at Database Layer — PostgreSQL Writable CTE Patterns and Pitfalls

### 3.1 The Core Pattern (as designed in ADR 03)

```sql
WITH
attempt_insert AS (
  INSERT INTO execution_event_log (scope_id, entity_id, predecessor_hash, event_type, payload, embedding)
  SELECT $scope_id, $entity_id, $predecessor_hash, $event_type, $payload, $embedding
  WHERE NOT EXISTS (
    SELECT 1 FROM execution_event_log
    WHERE predecessor_hash = $predecessor_hash AND scope_id = $scope_id
  )
  RETURNING *
),
conflict_insert AS (
  INSERT INTO execution_event_log (scope_id, entity_id, predecessor_hash, event_type, payload, embedding)
  SELECT $scope_id, $entity_id, winner.version_hash, 'conflict_detected', $payload_with_actual_basis, $embedding
  FROM execution_event_log winner
  WHERE winner.predecessor_hash = $predecessor_hash
    AND winner.scope_id = $scope_id
    AND NOT EXISTS (SELECT 1 FROM attempt_insert)
  RETURNING *
)
SELECT 'won' AS result FROM attempt_insert
UNION ALL
SELECT 'demoted' AS result FROM conflict_insert;
```

### 3.2 Known Pitfalls

**Pitfall 1: The UNIQUE constraint race between the NOT EXISTS check and the INSERT.**
Within a single transaction, the `WHERE NOT EXISTS` guard and the INSERT are not
atomic from other concurrent transactions' perspective under READ COMMITTED isolation.
Two transactions can both pass the NOT EXISTS check before either commits.
The UNIQUE constraint is the *actual* serialization point — the NOT EXISTS is an
optimization to avoid hitting the constraint, not a lock.

**Consequence:** Both transactions may attempt the INSERT. One gets the row; the other
gets a `unique_violation` (SQLSTATE 23505). The CTE's conflict_insert branch must handle
this: if attempt_insert raises 23505, the transaction should not abort — it should fall
through to conflict_insert. PostgreSQL Writable CTEs do not natively catch constraint
violations within the CTE body. The application layer must handle the exception and
re-execute the conflict_insert leg, or the CTE must be structured to avoid the race
(using INSERT ... ON CONFLICT DO NOTHING with RETURNING to detect the outcome).

**Recommended pattern:**
```sql
INSERT INTO execution_event_log (...)
VALUES (...)
ON CONFLICT (predecessor_hash, scope_id) DO NOTHING
RETURNING version_hash, 'won' AS result;
-- If no row returned: SELECT winner and INSERT conflict_detected
```
This is safer than NOT EXISTS because ON CONFLICT DO NOTHING is atomic at the
constraint level.

**Pitfall 2: Hash computation inside the CTE.**
ADR 02/03 specify that version_hash is computed by pgcrypto inside the transaction.
The `canonical_json(payload)` function must be deterministic: same payload, same key
ordering, same hash. If any upstream code path produces non-canonical JSON (e.g.,
Python dict with random iteration order, or float serialization differences across
environments), two logically identical writes will produce different hashes and never
collide — defeating OCC entirely.

**Mitigation:** Enforce payload canonicalization at the application layer before the
DB call (sort keys, normalize floats). Add a test that writes the same payload from
two different paths and asserts identical hashes.

**Pitfall 3: Partitioned tables and UNIQUE constraints.**
On a partitioned table (`PARTITION BY LIST (scope_id)`), a global UNIQUE constraint
cannot span partitions. ADR 04 correctly puts the UNIQUE constraint on each partition
subchild (`uk_scope_composite_occ_{id}`). However, this means the OCC guarantee is
per-partition only. If two events somehow write into different partitions for the
same scope_id (which should be impossible given the LIST partition key, but can
happen if the partition key expression has edge cases), the UNIQUE constraint will
not fire across partitions.

**Verification required:** Confirm that PostgreSQL LIST partition routing is deterministic
and that `scope_id` is always a literal UUID match, never a cast expression that could
route to an unexpected partition.

**Pitfall 4: DDL lock during Scope creation (ADR 05).**
`CREATE TABLE ... PARTITION OF` acquires `AccessExclusiveLock` on the parent table.
All concurrent reads AND writes on the parent table wait until DDL commits.
ADR 05 mitigates this by isolating DDL to a dedicated control connection and
pre-creating partition buffers during low-traffic periods.

**Residual risk:** If the control plane creates a new Scope partition during a burst
of concurrent Worker writes on other active Scopes, those Writers will see a brief
stall. The pre-creation buffer pool size must be tuned to the expected Scope creation
rate. If the buffer runs dry during a burst, latency spikes are unavoidable.

**Pitfall 5: Visibility gap under high INSERT concurrency.**
PostgreSQL BIGSERIAL auto-increment does not guarantee that row N is visible before
row N+1. A transaction inserting row 101 can commit after the transaction inserting
row 102. The HWM-based catchup (`WHERE id > last_processed_event_id`) can skip row 101
if the HWM has already advanced to 102.

**Mitigation options:**
- Use `pg_snapshot_xmin()` / `txid_snapshot_xmin()` watermarking instead of raw id comparison.
- Or: add a short polling delay (50-100ms) before advancing HWM to allow in-flight
  transactions to commit.
- Or: use `SELECT ... FOR UPDATE SKIP LOCKED` on a delivery queue table separate from
  the append log (adds write amplification but eliminates visibility gap entirely).

---

## 4. pgvector + tsvector Hybrid Retrieval

### 4.1 Two-Phase ANN + BM25 RRF — What the Research Says

**BEIR benchmark (2021, Thakur et al.):** Hybrid retrieval consistently outperforms
either dense (ANN) or sparse (BM25) alone across knowledge-intensive tasks. The margin
is largest for queries with specific named entities, error codes, and technical terms —
exactly the query profile of agent memory retrieval (e.g., "what happened when we called
the Stripe API" or "Python ImportError resolution").

**BEIR finding that matters here:** BM25 outperforms dense retrieval on datasets with
high vocabulary specificity (technical documentation, code). Dense retrieval outperforms
BM25 on paraphrase/semantic similarity tasks. Hybrid with RRF captures both.

**RRF (Reciprocal Rank Fusion, Cormack et al. 2009):** K=60 is the standard constant
from the original paper. The constant was tuned to minimize sensitivity to top-rank
score inflation; K=60 is robust across diverse query distributions. The ADR 20
implementation correctly uses K=60.

**agentmemory benchmark (the source cited in ADR 20):** The 0.6/0.4 (vector/BM25)
weight split is the default from the HybridSearch implementation, not a tuned result
for this specific corpus. This is a known gap — see Pitfalls below.

### 4.2 Known Benchmarks

| System | ANN Only (Recall@10) | BM25 Only | Hybrid RRF | Notes |
|--------|---------------------|-----------|------------|-------|
| MS MARCO (web queries) | ~0.85 | ~0.78 | ~0.89 | Semantic queries favor ANN |
| BEIR/SciFact | ~0.68 | ~0.72 | ~0.81 | Technical vocab favors BM25 |
| BEIR/TREC-COVID | ~0.59 | ~0.65 | ~0.73 | Strong BM25 domain |
| Code search (typical) | ~0.72 | ~0.81 | ~0.86 | Identifier exact match needs BM25 |

The agent memory corpus (error_patterns, API names, entity UUIDs, Chinese + English mixed)
is structurally closer to BEIR/SciFact and code search — BM25 is not just a complement
here, it is essential for exact-match retrieval.

### 4.3 Pitfalls

**Pitfall 1: `'simple'` tokenizer and CJK content.**
ADR 20 uses `to_tsvector('simple', ...)` for CJK compatibility. The `simple` config
tokenizes on whitespace and punctuation only. Chinese text has no whitespace between
words. Without a CJK-aware tokenizer (e.g., `zhparser` or character-level unigrams),
`to_tsvector('simple', '执行图原语')` produces a single token `执行图原语` that will
never match a query for `执行图`. This is a hard blocker for Chinese-language memory
content BM25 retrieval.

**Mitigation options:**
- Install `zhparser` PostgreSQL extension for Chinese word segmentation.
- Or: pre-process Chinese text to character-level n-gram space before storage
  (e.g., store `执 行 图 原 语` as space-delimited characters). This degrades
  recall for multi-character compounds but works without extensions.
- Or: accept BM25 is English-only and rely on vector search for Chinese-language queries.
  Document this limitation explicitly.

**Pitfall 2: Weight tuning not validated on this corpus.**
The 0.6/0.4 split was borrowed from agentmemory defaults. For a corpus of agent
execution events (short, structured, mixed-language), this split is unvalidated.
Vector search may dominate for semantic similarity; BM25 may dominate for exact
entity lookups. The optimal weight likely varies by memory table (episodic vs.
procedural have different query patterns).

**Mitigation:** Run offline ablation: compare Recall@5 for vector-only, BM25-only,
and hybrid at (0.5/0.5), (0.6/0.4), (0.7/0.3) on a sample of 50-100 real retrieval
queries from production traces. Re-tune before Phase 04 benchmarking.

**Pitfall 3: HNSW index build time during partition creation.**
ADR 04 specifies `CREATE INDEX ... USING hnsw` during the Scope's DDL nesting protocol.
For new (empty) partitions this is instant. But if the pre-creation buffer pool
pre-populates partitions with skeleton graph events, the HNSW build on non-empty
data during the DDL phase adds to the `AccessExclusiveLock` hold time.

**Recommendation:** Build HNSW index `CONCURRENTLY` after initial data load during
pre-population, not during the live DDL nesting window.

**Pitfall 4: GIN index selectivity on short documents.**
The BM25 path uses `ts_doc @@ query` which requires GIN index lookup. For very short
documents (episodic memory summaries of 20-50 words), GIN block-level selectivity is
low — many blocks will match any query token. The BM25 scan may degrade to near
sequential scan on large tables. Profile at 100k+ rows; consider partial indexes or
column-specific weighting.

**Pitfall 5: RRF penalty value for missing-stream records.**
ADR 20 uses rank=21 as the missing-stream penalty (just outside the Top-20 pool).
This means a record present in only one stream scores `1/(60+21) ≈ 0.012` on the
missing track. A record ranked #1 in only one stream scores `(1/61) + 0.012 ≈ 0.028`.
A record ranked #1 in both streams scores `2/61 ≈ 0.033`. The penalty is mild — a
strong single-stream result still ranks above a weak dual-stream result.

This is generally correct behavior. The one risk: if the BM25 pool consistently returns
0 results (due to CJK tokenization failure), all records are in "vector-only" mode and
score as if BM25 never existed. The RRF formula silently degrades to vector-only ranking
without any error signal. Add a metric: log when bm25_candidates returns 0 rows.

---

## 5. Domain Expert Evaluation Criteria

### 5.1 Who the Domain Experts Are

| Role | Evaluation Focus |
|------|-----------------|
| Distributed systems engineer | OCC correctness, replay safety, partition behavior under concurrent writes |
| LLM application engineer | Context fidelity, Knapsack Slicing correctness, token budget enforcement |
| Database engineer (PostgreSQL) | Query plan stability, HNSW/GIN index health, vacuum behavior on append-only partitions |
| Agent runtime operator | Scope lifecycle reliability, watchdog false-positive rate, cold-start latency |
| AI/ML engineer | Retrieval quality (Recall@K), RRF weight tuning, embedding model alignment with corpus |

### 5.2 Rubric Ingredients

---

**Dimension: Causal chain integrity**
Good: Every event in execution_event_log has a valid predecessor_hash that resolves to
an existing row, except the single root `plan_created` node of each Scope. The chain is
fully traversable from any node to N_root without gaps.
Bad: An event's predecessor_hash points to a non-existent row. A node has two rows with
the same predecessor_hash but both show `event_type = 'memory_updated'` (OCC did not
fire). A node's computed SHA-256 does not match its stored version_hash.
Stakes: Critical
Source: System correctness invariant — a broken chain makes Knapsack Slicing produce
wrong LLM context, with no visible error to the user.

---

**Dimension: OCC resolution completeness**
Good: Every `conflict_detected` event has exactly one corresponding convergence node
(`memory_updated` from ConflictResolverWorker) that references its version_hash in
the Convergence Gate payload. No Scope closes while unresolved `conflict_detected`
events exist in its partition.
Bad: A `conflict_detected` event has no downstream convergence node after the Scope
closes. Two `memory_updated` events share the same predecessor_hash in the same partition.
A ConflictResolverWorker produced a convergence node that references a
`conflicted_basis_hash` pointing to the wrong event.
Stakes: Critical
Source: ADR 03 invariants; a missed conflict silently drops one Worker's work product.

---

**Dimension: Topological Horizon completeness**
Good: The DAG slice delivered to the LLM for a given Worker activation contains the
root `plan_created` event, all direct ancestors via predecessor_hash chain, all
in-scope pending sibling nodes, and fits within W_max with delta_padding reserve.
Bad: The slice is truncated in a way that removes the root intent node. A sibling
node is missing because it was created after the hot graph snapshot. The token count
of the assembled prompt exceeds W_max (context overflow). The slice contains events
from a different Scope.
Stakes: Critical
Source: "Lost in the Middle" failure mode described in RFC 1.1; LLM without N_root
in context will hallucinate original intent.

---

**Dimension: Memory retrieval relevance**
Good: For a given Scope cold-start, the Top-3 procedural_memory matches returned have
final_score > 0.7 and at least 2 of 3 correspond to a Scope that a human expert would
identify as semantically similar to the new intent. BM25 path returns at least 1 result
for queries containing exact entity names or error codes.
Bad: The Top-1 match is a negative sample (is_anti_pattern = TRUE) returned in the
positive candidate set. BM25 path returns 0 results for a query that contains an exact
string present in intent_description. The vector path returns semantically unrelated
results because embedding model drift has made old embeddings incompatible with new
query embeddings.
Stakes: High
Source: Cold-start skeleton graph quality directly determines Worker planning quality
for the first execution cycle.

---

**Dimension: Scope lifecycle determinism**
Good: Every Scope that reaches all-nodes-converged state receives exactly one
`scope_closed` event, emitted only by the Topological Convergence Watchdog. Closed
Scopes are archived to cold table within SLA (e.g., within 60s of close event).
Bad: A Scope receives `scope_closed` while a ConflictResolverWorker is still running
(premature close). A Scope that has been fully converged never receives `scope_closed`
(watchdog false negative). Two `scope_closed` events exist for the same scope_id (watchdog
double-fire). A Scope partition is not detached/archived after close, causing hot table
bloat.
Stakes: High
Source: ADR 19 (Watchdog three-tier defense); ADR 06 (cold archival). Premature close
is a data loss event; missed close causes hot table unbounded growth.

---

**Dimension: Event bus delivery reliability**
Good: After a Worker disconnect and reconnect, all events with id > last HWM are
re-delivered in BIGSERIAL order, with no events skipped and no events delivered twice.
LISTEN/NOTIFY latency from INSERT commit to Worker receipt is under 50ms at p99.
Bad: An event is permanently lost after a disconnect (HWM advanced past a row that
was not yet visible due to transaction ordering). An event is delivered twice, causing
a Worker to attempt double-processing the same event_id. Events arrive out of
BIGSERIAL order, causing Knapsack Slicing to build an incorrect DAG.
Stakes: High
Source: ADR 08/09; at-least-once delivery is the bus contract. Visibility gap under
high concurrency is the primary production risk.

---

### 5.3 Critical Production Failure Modes (Domain-Specific)

**Failure Mode 1: Silent OCC bypass (hash collision or constraint miss)**
Scenario: A bug in canonical_json serialization causes two different payloads to
produce the same version_hash. Or a pgcrypto edge case (NULL handling in the
concatenation matrix) causes hash computation to return NULL, which does not match
the UNIQUE constraint and allows duplicate inserts.
Detection: Add a CI invariant check: for every partition, assert `COUNT(*) = COUNT(DISTINCT version_hash)`.
Consequence if missed: Two conflicting writes both land as `memory_updated` on the same
predecessor, producing a split chain that Knapsack Slicing will non-deterministically
choose between. LLM context becomes corrupted across calls.

**Failure Mode 2: Knapsack token budget overflow**
Scenario: A deep Scope with many ancestor events + many pending siblings pushes the
assembled context over W_max even after Knapsack truncation, because delta_padding
under-estimated actual prompt overhead (system prompt, tool schema, response reservation).
Detection: Monitor actual `usage.prompt_tokens` vs. W_max on every LLM call. Alert when
actual > W_max - response_reservation.
Consequence if missed: LLM API returns a context length error. Worker fails. The event
is not written. The Scope stalls silently unless the bus has a dead-letter mechanism.

**Failure Mode 3: Convergence watchdog false negative**
Scenario: All Worker tasks complete and no pending events remain, but the watchdog's
in-memory atomic counter is incorrect because a Worker crashed after writing its event
but before decrementing the counter (or the counter was never incremented for a
spawned sub-task).
Detection: The database B-Tree terminal audit SQL in the watchdog three-tier defense
should catch this. Verify the audit query actually runs after every candidate close
condition, not just as a fallback.
Consequence if missed: Scope runs forever. Hot partition is never archived. Memory
leaks over time. If the system has hundreds of leaked Scopes, DDL nesting for new
Scopes will degrade due to parent table lock contention.

**Failure Mode 4: Embedding model drift**
Scenario: The embedding model used to generate vectors for procedural_memory and
episodic_memory is upgraded or replaced. Existing stored embeddings are in the old
embedding space; new query embeddings are in the new space. HNSW ANN returns
semantically random results. No error is thrown.
Detection: Track embedding model fingerprint per row (the system already stores
`payload._meta.tokens[model_fingerprint]` for token counting; extend this pattern
to store embedding_model_id per memory row). Alert when a query embedding's model_id
does not match the dominant model_id in a memory table.
Consequence if missed: Cold-start skeleton graph selection becomes random. Workers
planning from wrong templates produce incorrect sub-task decompositions that the
system has no way to detect without human review.

**Failure Mode 5: Orphan node accumulation without reflection**
Scenario: LLM hallucinations or external tool failures generate many Orphan Nodes
(dead-end branches). These are correctly preserved in the ledger, but
TemplateProposalWorker is not writing them as `is_anti_pattern = TRUE` records.
Over time, the negative example store is empty while the positive store accumulates
paths that include hallucination recovery sequences.
Detection: After each Scope close, assert that if `error_count > 0` in the Scope's
episodic summary, at least one `is_anti_pattern = TRUE` record was written to
procedural_memory.
Consequence if missed: The system fails to learn from failures. Future cold-starts
repeat the same hallucination paths. The core "adaptive evolution" property of the
system is silently broken.

---

## 6. Regulatory / Compliance Context

This system is developer infrastructure (agent runtime), not a regulated-industry
end-user product. No HIPAA, GDPR data residency, FCA, or SOC2 compliance constraints
are directly imposed by the domain.

**Relevant considerations:**
- The append-only ledger and cryptographic hash chain are architecturally aligned with
  audit trail requirements that regulated-industry *consumers* of this runtime may impose.
  If this runtime is used to build healthcare or financial agents, the tamper-evidence
  properties become compliance-relevant for those deployments.
- pgcrypto SHA-256 is FIPS 140-2 compatible. If a downstream deployment operates in a
  FIPS environment, no changes are required.
- Chinese-language content in the CONTEXT.md and RFC suggests the deployment may be
  subject to China's Personal Information Protection Law (PIPL) if any personal data
  flows through agent memory. The SSOT append-only design makes deletion (PIPL Article 47
  right of erasure) architecturally difficult — this is a known tension in event-sourced
  systems. Document this as a consumer responsibility, not a runtime responsibility.

---

## 7. Research Sources

- RFC_v4.md and ADR_v4.md (in-repo): primary architecture specification
- CONTEXT.md (in-repo): canonical domain terminology
- ADR 20 supplement (in-repo): hybrid retrieval specification
- Cormack, G.V., Clarke, C.L.A., & Buettcher, S. (2009). Reciprocal rank fusion outperforms condorcet and individual rank learning methods. SIGIR 2009.
- Thakur, N., et al. (2021). BEIR: A heterogeneous benchmark for zero-shot evaluation of information retrieval models. NeurIPS 2021.
- Temporal.io engineering blog: "Workflow History and ContinueAsNew" — replay storm patterns
- EventStoreDB documentation: optimistic concurrency via expectedVersion
- PostgreSQL documentation: Writable CTEs, ON CONFLICT behavior, LISTEN/NOTIFY, partition constraint behavior
- LangGraph documentation: state checkpointing and persistence backends
- agentmemory project (HybridSearch implementation): source of 0.6/0.4 RRF weight defaults
- Martin Fowler: "Event Sourcing" pattern (martinfowler.com) — projection divergence and schema evolution patterns
- "Lost in the Middle" (Liu et al., 2023): LLM context position bias — motivation for N_root anchoring in Knapsack Slicing
