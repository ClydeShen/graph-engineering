# Graph-Native Agent Runtime — Technical Research

**Date:** 2026-05-31
**Scope:** MVP implementation patterns across six technical domains
**Domain terminology:** Per `Graph Engineering/CONTEXT.md` — Entity, Version, Hyper-edge, Scope, OCC, Writable CTE, HWM

---

## Domain 1: pg_notify LISTEN/NOTIFY — Rust Async Patterns

### PostgreSQL-Side Facts

**Payload limit:** 8000 bytes (default). [CITED: postgresql.org/docs/current/sql-notify.html]

`pg_notify()` functional form is required for dynamic channel names inside SQL:
```sql
SELECT pg_notify('graph_events', '{"event_id": 42}');
```
The `NOTIFY channel, payload` syntax requires a literal — use `pg_notify()` for computed values. [CITED: postgresql.org/docs/current/sql-notify.html]

**Transaction delivery:** Notifications are enqueued at `NOTIFY` time but delivered only after the enclosing transaction commits. Aborted transactions discard all notifications. Listening sessions receive notifications only between their own transactions (not mid-transaction). **Consequence for iii-engine:** keep the LISTEN connection outside of any open transaction; never start a transaction on the LISTEN connection. [CITED: postgresql.org/docs/current/sql-listen.html]

**Deduplication:** Identical (channel, payload) pairs within a single transaction collapse into one delivery. Different payloads always produce separate notifications. This means a single-byte pulse design (or a UUID per notification) is immune to deduplication collapse — but if you emit the same event_id twice in one transaction, only one pulse arrives. [CITED: postgresql.org/docs/current/sql-notify.html]

**Race condition on LISTEN registration:** LISTEN takes effect at commit. The safe pattern is:
1. Commit the `LISTEN` command first.
2. Then read current HWM from `bus_state`.
3. Then rely on notifications for new events.
If you read first and then LISTEN, you can miss events committed in the gap. [CITED: postgresql.org/docs/current/sql-listen.html]

**Queue:** 8 GB notification queue. If full, `NOTIFY` at commit fails. Monitor with `SELECT pg_notification_queue_usage();`. [CITED: postgresql.org/docs/current/sql-notify.html]

### Rust / tokio-postgres API

**Library:** `tokio-postgres` (crate: `tokio-postgres`, version ~0.7.x). [ASSUMED]

The `Client::notifications()` method returns a `Notifications` handle. This is a borrow of internal state — the `Client` and its connection future (`Connection`) must both be driven concurrently. The standard setup is: [ASSUMED]

```rust
// Source: tokio-postgres crate design [ASSUMED]
use tokio_postgres::{NoTls, AsyncMessage};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (client, mut connection) = tokio_postgres::connect(
        "host=localhost dbname=graphdb user=iii_engine",
        NoTls,
    ).await?;

    // Spawn connection driver — this MUST run for notifications to arrive.
    // The connection future polls the socket and routes incoming messages.
    let connection_handle = tokio::spawn(async move {
        // Poll messages out of the connection. The connection future yields
        // Poll::Ready(None) when the server closes the connection.
        // For LISTEN, you need to forward AsyncMessage::Notification items.
        // The standard approach uses Connection::poll_message() directly
        // OR drives via a channel.
        if let Err(e) = connection.await {
            eprintln!("connection error: {}", e);
        }
    });

    // LISTEN before reading HWM — commit happens implicitly for simple_query
    client.simple_query("LISTEN graph_events").await?;

    // Now read current HWM from bus_state to know replay boundary
    let rows = client.query(
        "SELECT last_processed_event_id FROM bus_state WHERE worker_id = $1",
        &[&worker_id],
    ).await?;

    // Receive notifications
    // notifications() returns &mut Notifications<'_>
    // next() is an async fn returning Option<Notification>
    let mut notifs = client.notifications();
    loop {
        // next() drives the underlying connection
        match notifs.next().await {
            Some(notification) => {
                let payload = notification.payload();
                // parse event_id from 64-byte pulse JSON
            }
            None => {
                // Connection closed — reconnect
                break;
            }
        }
    }

    Ok(())
}
```

**Critical architectural note:** `tokio-postgres` documentation states that the `Connection` object must be polled (driven) concurrently with the `Client`. If you `await connection` in a blocking manner, the `Client` methods will stall. Use `tokio::spawn` for the connection. [ASSUMED]

**Alternative — using `Connection::poll_message` for fine-grained control:** [ASSUMED]

```rust
use std::pin::Pin;
use tokio_postgres::AsyncMessage;
use futures_util::stream::StreamExt;

// Spawn a task that reads raw messages and routes notifications
// to a tokio mpsc channel
let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();

tokio::spawn(async move {
    let mut conn = connection;
    loop {
        // poll_message drives the underlying socket and yields
        // AsyncMessage::Notification, AsyncMessage::Notice
        match futures_util::future::poll_fn(|cx| conn.poll_message(cx)).await {
            Ok(Some(AsyncMessage::Notification(n))) => {
                let _ = tx.send(n);
            }
            Ok(Some(_)) => {} // Notice, ignore
            Ok(None) => break, // server closed
            Err(e) => {
                eprintln!("connection error: {e}");
                break;
            }
        }
    }
});
```

This pattern is preferred for iii-engine because it separates the network driver from the consumer loop and allows the notification stream to feed a `tokio::select!` alongside reconnect timers.

### HWM Tracking Pattern

HWM (`last_processed_event_id`) is stored in `bus_state` per the CONTEXT.md spec. The correct update pattern:

```rust
// After successfully processing an event with event_id N:
client.execute(
    "UPDATE bus_state SET last_processed_event_id = $1
     WHERE worker_id = $2 AND last_processed_event_id < $1",
    &[&event_id, &worker_id],
).await?;
```

The `< $1` guard makes the update idempotent — if a notification is processed twice (reconnect replay), the HWM does not regress. [ASSUMED]

### Reconnect and Replay Pattern

```rust
// Reconnect loop skeleton [ASSUMED]
loop {
    match connect_and_listen(&config).await {
        Ok((client, notif_rx)) => {
            // 1. Read current HWM
            let hwm = fetch_hwm(&client, worker_id).await?;
            // 2. Replay missed events since HWM via point query on read pool
            replay_since(&read_pool, hwm).await?;
            // 3. Consume live notifications
            while let Some(n) = notif_rx.recv().await {
                process_notification(n).await?;
                advance_hwm(&client, n.event_id).await?;
            }
            // connection dropped — loop back to reconnect
        }
        Err(e) => {
            tracing::error!("reconnect failed: {e}");
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}
```

### Pitfalls

1. **Forgetting to drive the connection:** `Client` methods hang forever if the `Connection` future is not being polled. Always `tokio::spawn` the connection task before doing anything with `Client`. [ASSUMED]

2. **Long-open transactions blocking queue cleanup:** If the LISTEN connection starts a transaction (e.g., for a `SELECT` before LISTEN), it blocks dead notification cleanup. Keep the LISTEN connection transaction-free. [CITED: postgresql.org/docs/current/sql-notify.html]

3. **Payload deduplication:** Two `pg_notify('graph_events', '{"id":42}')` calls in the same transaction produce one delivery. If you want guaranteed-unique delivery, include a unique nonce in the payload or emit from the `RETURNING` result of the INSERT (each INSERT produces one notification, payload = event_id as text). [CITED: postgresql.org/docs/current/sql-notify.html]

4. **LISTEN takes effect at commit:** After `client.simple_query("LISTEN graph_events")` the listen is active. But there's a window between the LISTEN commit and reading the HWM where events may arrive that you haven't queued. Solution: read HWM after LISTEN, not before. [CITED: postgresql.org/docs/current/sql-listen.html]

5. **64-byte pulse design is correct:** The CONTEXT.md spec uses a 64-byte pulse (event_id only). The actual event data is fetched via read-pool point query. This avoids the 8000-byte limit concern for large payloads. [CITED: postgresql.org/docs/current/sql-notify.html (8000 byte limit)]

6. **sqlx alternative:** `sqlx::postgres::PgListener` wraps the LISTEN/NOTIFY pattern in a higher-level API with auto-reconnect. It internally handles the `Connection` polling. Trade-off: less control over the connection lifecycle vs. tokio-postgres. [ASSUMED — verify against sqlx docs before choosing]

---

## Domain 2: Writable CTE with UNIQUE Constraint — Atomic OCC

### Design Goal

Per CONTEXT.md: one round-trip that either writes `memory_updated` (winner) or atomically writes `conflict_detected` (loser), without the loser throwing an exception. The UNIQUE constraint is `UNIQUE(predecessor_hash, scope_id)`.

### Verified SQL Primitives

`ON CONFLICT (column) DO UPDATE SET ... RETURNING` is a single atomic operation. The `EXCLUDED` pseudo-table holds the proposed values. [CITED: postgresql.org/docs/current/sql-insert.html]

`WITH (CTE) INSERT ... ON CONFLICT ... RETURNING` is fully supported. [CITED: postgresql.org/docs/current/sql-select.html — "Data-modifying statements in WITH clauses"]

### Exact Pattern for Atomic OCC

```sql
-- Worker A and Worker B both try to advance the same predecessor_hash.
-- Only one wins. The loser gets demoted to conflict_detected in the same statement.

WITH attempt AS (
    -- Try to insert as memory_updated
    INSERT INTO execution_event_log (
        scope_id,
        entity_id,
        event_type,
        predecessor_hash,
        version_hash,
        payload,
        created_at
    )
    VALUES (
        $1::uuid,    -- scope_id
        $2::uuid,    -- entity_id
        'memory_updated',
        $3::text,    -- predecessor_hash (the one we're trying to advance)
        encode(
            digest(
                $1::text || '|' || $2::text || '|' || $3::text
                    || '|memory_updated|' || $4::text,   -- $4 = canonical_json(payload)
                'sha256'
            ),
            'hex'
        ),
        $4::jsonb,   -- payload
        now()
    )
    ON CONFLICT (predecessor_hash, scope_id) DO UPDATE
        -- Loser: demote to conflict_detected.
        -- Predecessor hash is REWRITTEN to point to the winner's version_hash.
        -- The winner's version_hash is now in execution_event_log — fetch it.
        SET
            event_type        = 'conflict_detected',
            -- Causal inversion: predecessor_hash now points to the winner's version
            predecessor_hash  = (
                SELECT version_hash
                FROM execution_event_log
                WHERE predecessor_hash = $3::text
                  AND scope_id         = $1::uuid
                  AND event_type       = 'memory_updated'
                ORDER BY created_at DESC
                LIMIT 1
            ),
            version_hash      = encode(
                digest(
                    $1::text || '|' || $2::text
                        -- use the winner's version_hash as new predecessor
                        || '|' || (
                            SELECT version_hash
                            FROM execution_event_log
                            WHERE predecessor_hash = $3::text
                              AND scope_id         = $1::uuid
                              AND event_type       = 'memory_updated'
                            ORDER BY created_at DESC
                            LIMIT 1
                        )
                        || '|conflict_detected|' || $4::text,
                    'sha256'
                ),
                'hex'
            ),
            payload           = $4::jsonb,
            created_at        = now()
    RETURNING event_type, version_hash, entity_id, scope_id
)
SELECT event_type,
       version_hash,
       CASE event_type
           WHEN 'memory_updated'   THEN 'won'
           WHEN 'conflict_detected' THEN 'demoted'
       END AS occ_result
FROM attempt;
```

**Return value interpretation:**
- `occ_result = 'won'` — this Worker wrote the authoritative version.
- `occ_result = 'demoted'` — this Worker was demoted; ConflictResolverWorker should be notified.

### Simpler Two-Statement Alternative (Still Single Round-Trip via CTE)

The correlated subquery inside `DO UPDATE SET` is valid PostgreSQL but complex. A cleaner alternative is a two-CTE approach:

```sql
WITH
winner AS (
    -- First, who currently owns this predecessor slot?
    SELECT version_hash AS winner_hash
    FROM execution_event_log
    WHERE predecessor_hash = $3::text
      AND scope_id         = $1::uuid
      AND event_type       = 'memory_updated'
    LIMIT 1
),
insertion AS (
    INSERT INTO execution_event_log (
        scope_id, entity_id, event_type, predecessor_hash,
        version_hash, payload, created_at
    )
    SELECT
        $1::uuid,
        $2::uuid,
        CASE WHEN winner.winner_hash IS NULL
             THEN 'memory_updated'
             ELSE 'conflict_detected'
        END,
        CASE WHEN winner.winner_hash IS NULL
             THEN $3::text           -- original predecessor
             ELSE winner.winner_hash -- causal inversion: point to winner
        END,
        encode(
            digest(
                $1::text || '|' || $2::text
                || '|' ||
                CASE WHEN winner.winner_hash IS NULL
                     THEN $3::text
                     ELSE winner.winner_hash
                END
                || '|' ||
                CASE WHEN winner.winner_hash IS NULL
                     THEN 'memory_updated'
                     ELSE 'conflict_detected'
                END
                || '|' || $4::text,
                'sha256'
            ),
            'hex'
        ),
        $4::jsonb,
        now()
    FROM (SELECT NULL::text AS winner_hash) AS no_winner
    LEFT JOIN winner ON TRUE
    RETURNING event_type, version_hash
)
SELECT event_type,
       version_hash,
       CASE event_type
           WHEN 'memory_updated'    THEN 'won'
           WHEN 'conflict_detected' THEN 'demoted'
       END AS occ_result
FROM insertion;
```

**Note:** This second variant uses a left join to determine winner status before the INSERT. It is not truly atomic against concurrent writes in the same microsecond window — the `ON CONFLICT` form is strictly atomic because PostgreSQL serializes the index check and insert atomically. Use the `ON CONFLICT DO UPDATE` form for the actual OCC gate.

### Pitfalls

1. **`ON CONFLICT DO UPDATE` is atomic; the CTE without it is not.** Two concurrent transactions checking `WHERE predecessor_hash = X` before inserting can both see NULL and both insert `memory_updated`. The UNIQUE constraint enforces the serialization — the second one hits the conflict branch. [CITED: postgresql.org/docs/current/sql-insert.html — "ON CONFLICT DO UPDATE is deterministic"]

2. **`EXCLUDED` holds the row you tried to insert, not the winner.** To reference the winning row in `DO UPDATE SET`, you must either fetch it via a subquery or store it in a prior CTE arm. [CITED: postgresql.org/docs/current/sql-insert.html]

3. **Hash recomputation in `DO UPDATE` must use the post-inversion predecessor.** If you forget to change `predecessor_hash` before recomputing `version_hash`, the loser's hash will be cryptographically inconsistent with the canonical computation matrix. [ASSUMED — derived from CONTEXT.md hash matrix spec]

4. **`ON CONFLICT ON CONSTRAINT constraint_name` vs. column list.** Prefer naming the constraint explicitly: `ON CONFLICT ON CONSTRAINT uq_predecessor_hash_scope` to avoid ambiguity if other unique indexes exist on the table. [ASSUMED]

---

## Domain 3: pgcrypto digest() — SHA-256 Inside Writable CTEs

### Verified API

```sql
-- Returns bytea
SELECT digest('input_string', 'sha256');

-- Returns hex text (64 characters for SHA-256)
SELECT encode(digest('input_string', 'sha256'), 'hex');
```
[CITED: postgresql.org/docs/current/pgcrypto.html]

Extension must be loaded: `CREATE EXTENSION IF NOT EXISTS pgcrypto;` [CITED: postgresql.org/docs/current/pgcrypto.html]

### Canonical JSON Ordering for Hash Input

Per CONTEXT.md, the hash matrix is:
```
{scope_id}|{entity_id}|{predecessor_hash}|{event_type}|{canonical_json(payload)}
```

**PostgreSQL does not have a built-in canonical JSON serializer with guaranteed key order.** `jsonb::text` casts keys in alphabetical order by default because `jsonb` internally stores keys sorted. However, this behavior is an implementation detail and should not be relied upon across PostgreSQL versions. [ASSUMED — based on PostgreSQL jsonb storage spec]

Safe approach: define key order in application code before sending `$4`, and store the pre-serialized canonical string as a separate column or compute it from explicit `jsonb_build_object` calls with fixed-order keys:

```sql
-- Deterministic: explicit key ordering via jsonb_build_object
encode(
    digest(
        scope_id::text || '|' || entity_id::text || '|' ||
        predecessor_hash || '|' || event_type || '|' ||
        jsonb_build_object(
            'key1', payload->>'key1',
            'key2', payload->'key2'
        )::text,
        'sha256'
    ),
    'hex'
)
```

But this requires knowing the payload schema inside the function. The better approach: **compute the hash in the application layer** and pass it as `$5`, then verify it inside SQL before writing. This keeps hash computation deterministic independent of PostgreSQL version. [ASSUMED]

**If hash must be computed in PostgreSQL:** cast the `jsonb` payload to `text` — PostgreSQL's `jsonb` type always serializes with sorted keys. This is documented behavior for `jsonb` (not `json`). [ASSUMED — widely documented but not directly cited in session]

```sql
-- Safe because jsonb->text sorts keys alphabetically
encode(
    digest(
        $1::text || '|' || $2::text || '|' || $3::text
            || '|' || $4_event_type || '|' || $5_payload::jsonb::text,
        'sha256'
    ),
    'hex'
)
```

### Inside a Writable CTE

The `digest()` call works inside `INSERT ... SELECT`, `DO UPDATE SET`, and CTE arms: [CITED: postgresql.org/docs/current/pgcrypto.html — works in any SQL expression context]

```sql
WITH inserted AS (
    INSERT INTO execution_event_log (version_hash, ...)
    VALUES (
        encode(
            digest(
                scope_id::text || '|' || entity_id::text || '|' ||
                predecessor_hash || '|event_type|' || payload::text,
                'sha256'
            ),
            'hex'
        ),
        ...
    )
    RETURNING version_hash
)
SELECT version_hash FROM inserted;
```

### Pitfall: Text Encoding of bytea Parameter

If you pass `payload` as `text` and the text contains multi-byte UTF-8, `digest()` hashes the UTF-8 byte sequence. This is fine as long as all callers normalize to the same encoding (NFC). If payload is stored as `jsonb`, cast to `::text` before digest — `jsonb::text` always produces UTF-8. [ASSUMED]

---

## Domain 4: pgvector HNSW — Index Creation and Two-Phase RRF

### HNSW Index Creation Syntax

```sql
-- vector_cosine_ops for cosine similarity (normalized embeddings)
CREATE INDEX ON procedural_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

Operator classes: [ASSUMED — from pgvector documentation, not fetched in this session]
- `vector_cosine_ops` — cosine distance (`<=>` operator), use for normalized embeddings
- `vector_l2_ops` — Euclidean distance (`<->` operator)
- `vector_ip_ops` — inner product (`<#>` operator, returns negative inner product)

Parameters: [ASSUMED]
- `m` — number of bi-directional links per layer (default 16). Higher m = better recall, larger index, slower build.
- `ef_construction` — size of the dynamic candidate list during build (default 64). Higher = better recall, slower build.
- `ef_search` — size of candidate list during search (default 40). Set per-session: `SET hnsw.ef_search = 100;`

**Partial index for semantic_memory** (exclude superseded versions):
```sql
-- Source: pgvector HNSW patterns [ASSUMED]
CREATE INDEX ON semantic_memory
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
    WHERE superseded_by IS NULL;
```

**GIN index for tsvector (procedural memory keyword search):**
```sql
-- Source: postgresql.org/docs/current/textsearch-indexes.html [CITED]
CREATE INDEX ON procedural_memory USING GIN (search_vector);
```

### Cosine Distance Query

```sql
-- Top-20 ANN by cosine distance
-- <=> returns cosine distance (0=identical, 2=opposite)
-- 1 - (embedding <=> $1) gives cosine similarity
SELECT id, template_graph, quality_score,
       1 - (embedding <=> $1::vector) AS cosine_sim
FROM procedural_memory
WHERE is_anti_pattern = false
ORDER BY embedding <=> $1::vector
LIMIT 20;
```

Setting `ef_search` for higher recall at query time: [ASSUMED]
```sql
SET hnsw.ef_search = 100;
SELECT ... ORDER BY embedding <=> $1::vector LIMIT 20;
```

### Two-Phase ANN + RRF Hybrid Retrieval Stored Procedure

Per CONTEXT.md: procedural_memory uses "两阶段 Top-20 ANN + 三信号混合重排 (相似度×0.6 + 质量×0.3 + 时效×0.1)".

RRF (Reciprocal Rank Fusion) formula: `score = 1 / (k + rank)` where k=60 is standard. [ASSUMED — RRF is a well-established IR technique]

**Two-phase approach:**
- Phase 1: ANN retrieval (vector) gets top-N candidates (N > final K for recall padding).
- Phase 2: Re-rank with the three-signal formula on the candidate set.

```sql
-- Source: pattern derived from CONTEXT.md spec and pgvector/tsvector docs [ASSUMED]
CREATE OR REPLACE FUNCTION search_procedural_memory(
    query_embedding   vector(1536),
    query_tsquery     tsquery,
    result_limit      int DEFAULT 5
)
RETURNS TABLE (
    id              uuid,
    template_graph  jsonb,
    quality_score   float,
    final_score     float
)
LANGUAGE plpgsql AS $$
DECLARE
    ann_limit int := 20;  -- Phase 1: retrieve 20 candidates
BEGIN
    -- Phase 1: ANN top-20 by cosine distance only
    -- Phase 2: re-rank with three signals
    RETURN QUERY
    WITH ann_candidates AS (
        -- Vector ANN: top-20 nearest neighbors
        SELECT
            pm.id,
            pm.template_graph,
            pm.quality_score,
            pm.created_at,
            1 - (pm.embedding <=> query_embedding) AS cosine_sim,
            ts_rank_cd(pm.search_vector, query_tsquery) AS text_rank
        FROM procedural_memory pm
        WHERE pm.is_anti_pattern = false
        ORDER BY pm.embedding <=> query_embedding
        LIMIT ann_limit
    ),
    ranked AS (
        SELECT
            id,
            template_graph,
            quality_score,
            -- Three-signal re-ranking:
            -- similarity × 0.6 + quality × 0.3 + recency × 0.1
            (cosine_sim * 0.6)
                + (quality_score * 0.3)
                + (
                    -- Recency score: normalize to [0,1] over last 90 days
                    GREATEST(0.0,
                        1.0 - EXTRACT(EPOCH FROM (now() - created_at))
                              / (90.0 * 86400.0)
                    ) * 0.1
                ) AS final_score
        FROM ann_candidates
    )
    SELECT r.id, r.template_graph, r.quality_score::float, r.final_score::float
    FROM ranked r
    ORDER BY r.final_score DESC
    LIMIT result_limit;
END;
$$;
```

**Calling the procedure:**
```sql
SELECT * FROM search_procedural_memory(
    '[0.1, 0.2, ...]'::vector,
    to_tsquery('english', 'web & scraping'),
    5
);
```

### Pitfalls

1. **HNSW does not support exact KNN — it is approximate.** For exact results, do a sequential scan: `ORDER BY embedding <=> $1 LIMIT N` without the HNSW index (use `SET enable_indexscan = off`). Only use HNSW when approximate recall is acceptable. [ASSUMED]

2. **`ef_search` must be >= the query LIMIT.** If `ef_search = 40` and you query `LIMIT 100`, results degrade. Set `ef_search >= LIMIT * 2` for good recall at larger limits. [ASSUMED]

3. **Partial index on `superseded_by IS NULL` requires `WHERE` in query to match.** The planner will only use a partial HNSW index if the query includes the same predicate. Always include `WHERE superseded_by IS NULL` in semantic_memory queries. [ASSUMED]

4. **`vector_cosine_ops` requires non-zero vectors.** Zero vectors produce `NaN` cosine distance. Add an application-layer guard before inserting or querying with zero vectors. [ASSUMED]

5. **GIN + HNSW combined on one query:** PostgreSQL cannot use two indexes in a single scan. The two-phase approach (ANN first, tsvector re-rank second) is the correct workaround. Do NOT attempt `WHERE search_vector @@ tsquery AND ORDER BY embedding <=>` expecting both indexes to be used — only one will. [ASSUMED]

---

## Domain 5: Rust → TypeScript Worker Protocol — WebSocket Push

### Protocol Design

The iii-engine pushes events to TypeScript Workers over WebSocket. The Worker declares a JSON Schema subscription contract.

**Recommended message envelope:**
```json
{
  "type": "event_dispatch",
  "event_id": "123",
  "event_type": "conflict_detected",
  "scope_id": "uuid",
  "entity_id": "uuid",
  "version_hash": "hex64",
  "payload": { ... }
}
```

**Subscription contract (Worker → iii-engine at connect time):**
```json
{
  "type": "subscribe",
  "worker_id": "conflict-resolver-worker",
  "filter": {
    "event_types": ["conflict_detected"],
    "scope_id": null
  }
}
```

### Rust WebSocket Push (tokio-tungstenite)

```rust
// Source: tokio-tungstenite patterns [ASSUMED]
use tokio_tungstenite::{accept_async, tungstenite::Message};
use futures_util::{SinkExt, StreamExt};

// In the iii-engine accept loop:
tokio::spawn(async move {
    let ws_stream = accept_async(tcp_stream).await?;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // Receive subscription contract
    if let Some(Ok(Message::Text(sub_json))) = ws_receiver.next().await {
        let subscription: SubscriptionContract = serde_json::from_str(&sub_json)?;
        // Register subscription in DashMap<event_type, Vec<WorkerHandle>>
        router.register(subscription, ws_sender.clone());
    }

    // Keep connection alive — forward ping/pong
    while let Some(msg) = ws_receiver.next().await {
        match msg? {
            Message::Ping(data) => { ws_sender.send(Message::Pong(data)).await?; }
            Message::Close(_) => break,
            _ => {}
        }
    }
    // On disconnect: remove from DashMap
    router.deregister(worker_id);
    Ok::<(), anyhow::Error>(())
});
```

**Broadcasting to matching Workers from the notification consumer:**
```rust
// When a pg_notify arrives, look up subscribed workers and send
if let Some(workers) = router.get(&event.event_type) {
    let msg = serde_json::to_string(&event)?;
    for worker in workers.iter() {
        let _ = worker.sender.send(Message::Text(msg.clone())).await;
    }
}
```

### TypeScript Worker (ws or native WebSocket)

```typescript
// Source: Node.js ws library patterns [ASSUMED]
import WebSocket from 'ws';

const ws = new WebSocket('ws://iii-engine:3000/workers');

ws.on('open', () => {
  // Declare subscription contract
  ws.send(JSON.stringify({
    type: 'subscribe',
    worker_id: 'conflict-resolver-worker',
    filter: { event_types: ['conflict_detected'] }
  }));
});

ws.on('message', async (data: WebSocket.RawData) => {
  const event = JSON.parse(data.toString()) as GraphEvent;
  if (event.type === 'event_dispatch' && event.event_type === 'conflict_detected') {
    await handleConflict(event);
  }
});

ws.on('close', () => {
  // Reconnect with exponential backoff
  setTimeout(reconnect, 1000);
});
```

### JSON Schema Subscription Contract

Define with Zod for runtime validation: [ASSUMED]
```typescript
import { z } from 'zod';

export const EventDispatchSchema = z.object({
  type: z.literal('event_dispatch'),
  event_id: z.string(),
  event_type: z.enum([
    'plan_created', 'task_spawned', 'memory_updated',
    'conflict_detected', 'scope_closed'
  ]),
  scope_id: z.string().uuid(),
  entity_id: z.string().uuid(),
  version_hash: z.string().length(64),
  payload: z.record(z.unknown()),
});

export type EventDispatch = z.infer<typeof EventDispatchSchema>;
```

### Pitfalls

1. **Backpressure:** If a Worker is slow to consume, the WebSocket send buffer fills. Use `tokio::sync::mpsc::channel` with bounded capacity in Rust and drop or log when the channel is full. [ASSUMED]

2. **Worker reconnect loses subscription state:** When a Worker reconnects, it must re-send its subscription contract. The iii-engine should not assume re-connected sessions retain prior subscriptions. [ASSUMED]

3. **Message fragmentation:** WebSocket frames can be fragmented. The `ws` library in Node.js buffers them. `tokio-tungstenite` also handles fragmentation. Always use the library's message abstraction, never raw frame access. [ASSUMED]

---

## Domain 6: TypeScript LLM Integration — Claude API for ConflictResolverWorker

### Calling Claude API for Structured Output

Use tool_use with `tool_choice: { type: "tool", name: "emit_convergence_gate" }` to force structured JSON output. This is the reliable structured output pattern — Claude is forced to call the named tool, so the response is always the tool's `input` object. [ASSUMED — based on Anthropic API design; tool_choice forcing is documented in Anthropic SDK]

```typescript
// Source: @anthropic-ai/sdk TypeScript patterns [ASSUMED]
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// JSON Schema for convergence_gate payload
const CONVERGENCE_GATE_SCHEMA = {
  name: 'emit_convergence_gate',
  description: 'Emit the convergence gate payload for the merged version node.',
  input_schema: {
    type: 'object' as const,
    properties: {
      merged_content: {
        type: 'object',
        description: 'The semantically merged content of the two conflicting versions.',
      },
      legitimate_basis_hash: {
        type: 'string',
        description: 'version_hash of the winning (legitimate) predecessor.',
      },
      conflicted_basis_hash: {
        type: 'string',
        description: 'version_hash of the demoted (conflicted) predecessor.',
      },
      clash_scope_root_hash: {
        type: 'string',
        description: 'version_hash of the scope root node (plan_created event).',
      },
      merge_rationale: {
        type: 'string',
        description: 'One-sentence explanation of how the conflict was resolved.',
      },
    },
    required: [
      'merged_content',
      'legitimate_basis_hash',
      'conflicted_basis_hash',
      'clash_scope_root_hash',
      'merge_rationale',
    ],
  },
};

interface ConvergenceGatePayload {
  merged_content: Record<string, unknown>;
  legitimate_basis_hash: string;
  conflicted_basis_hash: string;
  clash_scope_root_hash: string;
  merge_rationale: string;
}

async function resolveConflict(
  legitimateVersion: GraphEvent,
  conflictedVersion: GraphEvent,
  topologicalContext: string,
): Promise<ConvergenceGatePayload> {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 2048,
    tools: [CONVERGENCE_GATE_SCHEMA],
    // Force the model to call this specific tool — no free-text response
    tool_choice: { type: 'tool', name: 'emit_convergence_gate' },
    messages: [
      {
        role: 'user',
        content: `You are the ConflictResolverWorker. Two Workers wrote conflicting versions of the same Entity.

LEGITIMATE version (won OCC):
${JSON.stringify(legitimateVersion.payload, null, 2)}
version_hash: ${legitimateVersion.version_hash}

CONFLICTED version (demoted):
${JSON.stringify(conflictedVersion.payload, null, 2)}
version_hash: ${conflictedVersion.version_hash}

Topological context (Knapsack slice):
${topologicalContext}

Scope root hash: ${legitimateVersion.scope_root_hash}

Semantically merge the two versions. Preserve all non-contradictory information from both. 
Call emit_convergence_gate with the merged result.`,
      },
    ],
  });

  // With tool_choice: { type: 'tool', name: '...' }, the response MUST contain a tool_use block
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUseBlock) {
    throw new Error('LLM did not return a tool_use block — unexpected response shape');
  }

  return toolUseBlock.input as ConvergenceGatePayload;
}
```

### Writing the Convergence Node Back to PostgreSQL

After getting `ConvergenceGatePayload`, write back as a `memory_updated` event with the convergence gate embedded in payload:

```typescript
// Source: derived from CONTEXT.md Convergence Gate spec [ASSUMED]
async function writeConvergenceNode(
  pg: Pool,
  event: GraphEvent,
  gate: ConvergenceGatePayload,
): Promise<void> {
  const payload = {
    ...gate.merged_content,
    _convergence_gate: {
      legitimate_basis_hash: gate.legitimate_basis_hash,
      conflicted_basis_hash: gate.conflicted_basis_hash,
      clash_scope_root_hash: gate.clash_scope_root_hash,
      merge_rationale: gate.merge_rationale,
    },
  };

  // Convergence node is a memory_updated event.
  // Its predecessor_hash = legitimate_basis_hash (the winner).
  // version_hash is computed by PostgreSQL via pgcrypto.
  await pg.query(
    `INSERT INTO execution_event_log (
        scope_id, entity_id, event_type, predecessor_hash,
        version_hash, payload, created_at
     )
     VALUES (
        $1::uuid, $2::uuid, 'memory_updated', $3::text,
        encode(
          digest($1::text || '|' || $2::text || '|' || $3::text
                 || '|memory_updated|' || $4::text, 'sha256'),
          'hex'
        ),
        $4::jsonb,
        now()
     )`,
    [
      event.scope_id,
      event.entity_id,
      gate.legitimate_basis_hash,      // predecessor = the winner
      JSON.stringify(payload),         // canonical JSON from application
    ],
  );
}
```

### Pitfalls

1. **`tool_choice: { type: 'tool', name: '...' }` requires the tool to be in the `tools` array.** If the name does not match exactly, the API returns an error. [ASSUMED]

2. **Token budget for topological context:** Per CONTEXT.md, the Divergent Reflection Track budget is `min(2000, W_max * 0.3)` tokens. The ConflictResolverWorker must truncate `topologicalContext` to this budget before inserting into the prompt. Use the Wasm Tokenizer result from `payload._meta.tokens[model_fingerprint]` if available. [ASSUMED — derived from CONTEXT.md spec]

3. **Never stream when using tool_use for structured output.** Streaming with tool_use requires buffering the full `input_json_delta` stream before parsing. For the ConflictResolverWorker, use non-streaming `messages.create()` to get a complete, parseable tool input in one call. [ASSUMED]

4. **`toolUseBlock.input` is `unknown` in TypeScript.** Always validate with Zod before writing to the database: [ASSUMED]
```typescript
import { z } from 'zod';

const ConvergenceGateSchema = z.object({
  merged_content: z.record(z.unknown()),
  legitimate_basis_hash: z.string().length(64),
  conflicted_basis_hash: z.string().length(64),
  clash_scope_root_hash: z.string().length(64),
  merge_rationale: z.string().max(500),
});

const gate = ConvergenceGateSchema.parse(toolUseBlock.input);
```

5. **Worker writes only `SELECT` and `INSERT`.** Per CONTEXT.md, data-plane Workers have `SELECT/INSERT` only. The `writeConvergenceNode` INSERT must succeed without needing UPDATE or DELETE. The OCC mechanism guarantees convergence nodes go in as fresh inserts (new unique `predecessor_hash`). [DERIVED from CONTEXT.md control plane / data plane permission split]

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | tokio-postgres `Client::notifications()` returns a `Notifications` handle with `.next()` async method | Domain 1 | API may differ — verify against docs.rs/tokio-postgres |
| A2 | `Connection::poll_message` exists and yields `AsyncMessage::Notification` | Domain 1 | Interface may have changed in 0.7.x — verify |
| A3 | `sqlx::postgres::PgListener` exists and provides auto-reconnect | Domain 1 | Package name / API may differ |
| A4 | HNSW index syntax: `USING hnsw (col vector_cosine_ops) WITH (m=16, ef_construction=64)` | Domain 4 | Syntax correct per widely-published pgvector docs but not fetched in session |
| A5 | `<=>` is the cosine distance operator in pgvector | Domain 4 | Operator symbol may differ — verify against pgvector README |
| A6 | `SET hnsw.ef_search = N` is the per-session ef_search control | Domain 4 | GUC name may differ across pgvector versions |
| A7 | Partial HNSW index `WHERE superseded_by IS NULL` is supported | Domain 4 | pgvector may not support partial HNSW indexes — verify |
| A8 | `tool_choice: { type: 'tool', name: '...' }` forces a specific tool call in Anthropic SDK | Domain 6 | API shape may have changed — verify against current Anthropic docs |
| A9 | `response.content.find(b => b.type === 'tool_use')` is the correct extraction path | Domain 6 | TypeScript type may differ |
| A10 | `jsonb::text` always produces alphabetically-sorted keys | Domain 3 | This is implementation behavior, not a documented guarantee |
| A11 | `tokio-tungstenite::accept_async` and `SinkExt::send` are the correct WebSocket server API | Domain 5 | Crate API may have changed |

---

## Verified Sources

### HIGH confidence (fetched from official docs in this session)
- `postgresql.org/docs/current/sql-notify.html` — pg_notify payload limit (8000 bytes), deduplication behavior, transaction delivery semantics
- `postgresql.org/docs/current/sql-listen.html` — LISTEN transaction behavior, race condition pattern
- `postgresql.org/docs/current/pgcrypto.html` — digest() syntax, supported algorithms, encode() hex output
- `postgresql.org/docs/current/sql-insert.html` — ON CONFLICT DO UPDATE, EXCLUDED table, RETURNING clause, atomic upsert guarantee
- `postgresql.org/docs/current/textsearch-indexes.html` — GIN index for tsvector, GIN vs GiST recommendation
- `postgresql.org/docs/current/textsearch-controls.html` — ts_rank_cd, weight arrays, normalization options

### MEDIUM confidence (training knowledge, widely-published patterns)
- tokio-postgres Notifications API — consistent with public documentation but not fetched live
- pgvector HNSW syntax — widely published in official pgvector README and Supabase/Neon docs
- Anthropic SDK tool_choice pattern — consistent with published Anthropic documentation

### LOW confidence (not verified in session)
- jsonb::text key-sort behavior being a documented guarantee (vs. implementation detail)
- tokio-tungstenite specific API shapes
