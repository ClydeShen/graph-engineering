# Phase 3: Pattern Discovery + MCP Bridging — Research

**Researched:** 2026-06-05
**Domain:** WL Graph Kernel, CrossScopePatternDiscovery, Nested Scope Activation, MCP Server (Streamable HTTP), agent_registry, FrontierScheduler skill-matching
**Confidence:** HIGH (core algorithms already stubbed in codebase), MEDIUM (MCP Streamable HTTP transport layer)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-1: Method B — Skill Routing (LOCKED)**
`task_spawned` payload declares `required_skills[]` only. `assigned_agent_id` is forbidden. All task dispatch sovereignty resides in FrontierScheduler, which queries `agent_registry`, matches skills via GIN index, dispatches via SKIP LOCKED.
Violation guard: Any payload field named `assigned_agent_id`, `preferred_agent`, or any explicit agent instance pointer is rejected.

**D-2: AgentCard Universalization (LOCKED)**
All participants — internal Workers and external Agents — register in `agent_registry` with an AgentCard declaring accepted skills.
Minimum AgentCard structure (A2A-protocol compatible): `{ agent_id, name, description, skills[], protocol, endpoint, version }`.

**D-3: Three Protocols Coexist (LOCKED)**
| Protocol | Target | Transport |
|---|---|---|
| MCP | Claude, Codex, Pi, LLM Agents | SSE + HTTP |
| A2A | Native A2A third-party systems | JSON-RPC |
| iii WebSocket | Internal Worker processes | WebSocket (existing) |

**D-4: Pull Primary, SSE Push Optional (LOCKED)**
Primary model: `Agent → claim_next_task(skills=[...]) → SKIP LOCKED → returns task or empty`.
SSE Push is a latency optimization only; push signals carry no task content.

**D-5: Ledger as Coordinator, No Central Daemon (LOCKED)**
State written to ledger (PostgreSQL), not process memory. Forbidden patterns: globally unique guardian daemon, central state server, in-process task state cache.

**D-6: Circular Dependency is a Design Error (LOCKED)**
Agent task dependencies MUST form a DAG. Phase 3 backstop is Watchdog TTL (D-5). spawned_by chain detection at dispatch time is DEFERRED to Phase 4 per user decision 2026-06-03.

**D-7: Claude Internal Sub-Agent Scheduling NOT Managed by graph-os (LOCKED)**
Claude manages its own sub-agent scheduling. graph-os only sees `spawn_subtask` calls. Fan-in via `wait_all_tasks(task_ids, timeout_s)` using PostgreSQL LISTEN/NOTIFY.

### Claude's Discretion
- WL graph kernel hyperparameters (iterations, kernel dimension)
- CrossScopePatternDiscovery clustering algorithm details (cosine threshold, minimum cluster size)
- `agent_registry` heartbeat TTL value
- MCP tool call input/output Zod schema specifics
- ADR numbering for new MCP Server component (new ADR 38 vs extension of ADR 24 + ADR 31)
- skills granularity standard

### Deferred Ideas (OUT OF SCOPE)
- Pi SDK `runtime.fork()` sandbox rehearsal mode
- Distributed lock for ConflictResolverWorker
- A2A JSON-RPC full implementation (Phase 3 only scaffolds the protocol)
- `wait_all_tasks` partial-completion semantics
</user_constraints>

---

## Summary

Phase 3 has two independent work streams that share a migration and an agent_registry foundation.

**Stream A — Pattern Discovery** is largely pre-built. The WL graph kernel (`computeWLEmbedding`) lives in `packages/workers/src/memory/wl-embedding.ts` and runs every time `ProceduralMemoryWorker.onSynthesizerOutput` fires. The `topology_embedding vector(128)` column and HNSW index on `procedural_memory` exist in migration 003. The `PatternDiscoveryWorker` stub in `packages/workers/src/patterns/discover.worker.ts` runs the corpus guard but leaves the body empty. Phase 3 fills that body with a `CrossScopePatternDiscoveryWorker` that does HNSW cosine similarity search and writes `cross_domain_cluster_id`. Nested scope propagation (ADR 23) needs the Control Plane extended to detect `spawn_sub_scope: true` in `task_spawned` and a new `SubScopeResultWorker` to handle `sub_scope_resolved`.

**Stream B — MCP Bridging** adds an MCP Server layer on top of the existing Hono gateway. The `@modelcontextprotocol/sdk` v1.29.0 ships a `McpServer` class and a `WebStandardStreamableHTTPServerTransport` that integrates directly with Hono's request/response model — no separate HTTP server needed. The SDK already lists `hono: "^4.11.4"` as a dependency (confirmed v4.12.23 in this project). The MCP Streamable HTTP spec (2025-11-25) uses a single `/mcp` endpoint accepting both `GET` (SSE push) and `POST` (tool calls). The agent_registry migration (007) is the shared foundation between the two streams — FrontierScheduler skill matching depends on it.

**Primary recommendation:** Implement Stream A first (CrossScopePatternDiscoveryWorker + nested scopes), then Stream B (agent_registry migration, MCP Server, FrontierScheduler skill-matching), because Stream A has no new npm dependencies and de-risks the Gate 4 cosine similarity criterion.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| WL kernel computation | Worker (ProceduralMemoryWorker) | — | Already runs in-process at template write time |
| CrossScopePatternDiscovery | Worker (PatternDiscovery cron) | PostgreSQL HNSW | Cron worker reads procedural_memory, writes cluster_id |
| cross_domain_cluster_id persistence | PostgreSQL (procedural_memory ALTER) | — | Column-level update per ADR 25 Phase 2 spec |
| Nested scope DDL interception | Control Plane Daemon | PostgreSQL scope_lineage | CP detects spawn_sub_scope:true, extends 3-phase nesting |
| sub_scope_resolved signal injection | Control Plane Daemon | — | ADR 23: CP is sole writer, does not go through bus enum |
| SubScopeResultWorker | Worker (iii-sdk subscriber) | LLM Provider | Listens for sub_scope_resolved, merges result into parent |
| MCP Server (tool routing) | API / Backend (Hono Gateway) | — | McpServer layered on top of existing buildApp() |
| agent_registry persistence | PostgreSQL | — | New table, migration 007 |
| Skill-based task dispatch | Worker (FrontierScheduler) | PostgreSQL GIN | FrontierScheduler queries agent_registry on dispatch |
| SSE push signals | API / Backend (Hono Gateway) | PostgreSQL NOTIFY | Extends existing Pulse-Fetch outward |
| AgentCard endpoint | API / Backend (Hono Gateway) | — | Static GET endpoint, no DB |

---

## Standard Stack

### Core (existing — no new installs)
| Library | Version | Purpose | Status |
|---------|---------|---------|--------|
| `hono` | 4.12.23 | HTTP framework for MCP endpoint mounting | Already installed [VERIFIED: npm registry] |
| `pg` | 8.21.0 | PostgreSQL queries for agent_registry + skill-matching | Already installed [VERIFIED: npm registry] |
| `zod` | 4.4.3 | Schema validation for MCP tool inputs | Already installed [VERIFIED: npm registry] |
| `@hono/zod-validator` | 0.8.0 | Gateway input validation | Already installed [VERIFIED: npm registry] |
| `pg-listen` | 1.7.0 | LISTEN/NOTIFY for SSE push bridge | Already installed [VERIFIED: npm registry] |

### New Dependency
| Library | Version | Purpose | Why |
|---------|---------|---------|-----|
| `@modelcontextprotocol/sdk` | 1.29.0 | McpServer + WebStandardStreamableHTTPServerTransport | Official MCP SDK; ships with native Hono support [VERIFIED: npm registry, slopcheck OK] |

**Installation (gateway package only):**
```bash
npm install @modelcontextprotocol/sdk
```

**Version verification:** `npm view @modelcontextprotocol/sdk version` → `1.29.0` (published 2024-11-11, last modified 2026-06-04). [VERIFIED: npm registry]

**Note:** `@modelcontextprotocol/sdk` bundles `hono: "^4.11.4"` as its own dependency and is compatible with the project's `hono: 4.12.23`. No version conflict.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `@modelcontextprotocol/sdk` | Hand-roll JSON-RPC + SSE | SDK handles session management, tool discovery, schema negotiation, reconnection — ~600 LOC of protocol plumbing |
| HNSW cosine similarity for clustering | k-means on Float32Array | HNSW is already indexed; pgvector `<=>` operator does cosine distance in a single SQL query |

---

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| `@modelcontextprotocol/sdk` | npm | 19 mo | High (official Anthropic) | github.com/modelcontextprotocol/typescript-sdk | OK | Approved |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
Stream A — Pattern Discovery:

ProceduralMemoryWorker (Phase 2, existing)
  │ computeWLEmbedding() [in-process]
  │ writes topology_embedding vector(128)
  └─→ procedural_memory table

PatternDiscoveryWorker cron (every 6h)
  │ corpus guard: count closed scopes
  │ CrossScopePatternDiscoveryWorker.run()
  │   → SQL: cosine sim > 0.90 AND intent distance > 0.50
  │   → UPDATE procedural_memory SET cross_domain_cluster_id = ...
  └─→ done

Stream A — Nested Scopes:

task_spawned event (spawn_sub_scope: true)
  │
  ▼
Control Plane (extended)
  │ detects spawn_sub_scope field
  │ runs 3-phase nesting (ADR 05 upgrade)
  │   → CREATE partition, INSERT scope_lineage w/ parent_scope_id
  └─→ child scope active

child scope closed (scope_closed event)
  │
  ▼
Control Plane
  │ reads scope_lineage → finds parent_scope_id
  │ direct-writes sub_scope_resolved to parent partition
  └─→ SubScopeResultWorker wakes

SubScopeResultWorker
  │ reads child scope tail node
  │ LLM: synthesize result summary
  └─→ writes memory_updated to parent scope

Stream B — MCP Bridging:

External Agent (Claude / Codex / Pi)
  │
  ├─ POST /mcp/messages  (JSON-RPC tool call)
  │    McpServer → tool handler
  │    → reads/writes PostgreSQL (agent_registry, execution_event_log)
  │    → returns JSON-RPC response
  │
  └─ GET  /mcp/sse       (SSE push stream)
       McpServer → WebStandardStreamableHTTPServerTransport
       PostgreSQL NOTIFY → Pulse-Fetch → SSE writeSSE()
       Agent receives signal → calls claim_next_task()

FrontierScheduler (extended):
  graph::frontier::changed
    → existing Top-K SQL
    → NEW: JOIN agent_registry ON skills && required_skills (GIN)
    → SKIP LOCKED dispatch to matched agents
```

### Recommended Project Structure

```
packages/
├── gateway/src/
│   ├── routes/
│   │   ├── mcp.ts           # McpServer mount: GET /mcp/sse, POST /mcp/messages
│   │   ├── agents.ts        # POST /v1/agents/register, GET /.well-known/agent-card.json
│   │   └── [existing]
│   └── mcp/
│       ├── server.ts        # buildMcpServer(pool): registers 7 tools
│       └── tools/
│           ├── spawn-subtask.ts
│           ├── claim-next-task.ts
│           ├── get-task-status.ts
│           ├── complete-task.ts
│           ├── wait-all-tasks.ts
│           ├── register-agent.ts
│           └── query-context.ts
├── workers/src/
│   ├── patterns/
│   │   ├── discover.worker.ts    # EXTEND: fill stub body with CrossScopePatternDiscovery
│   │   └── cross-scope.ts        # CrossScopePatternDiscoveryWorker (new)
│   └── nested/
│       └── sub-scope-result.worker.ts   # SubScopeResultWorker (new)
├── control-plane/src/
│   └── nesting.ts           # EXTEND: detect spawn_sub_scope, sub_scope_resolved injection
├── shared/src/
│   └── constants.ts         # EXTEND: add AGENT_HEARTBEAT_TTL_S constant
migrations/
└── 007-agent-registry.sql   # CREATE TABLE agent_registry + cross_domain_cluster_id column
```

### Pattern 1: MCP Server + Hono Integration (Streamable HTTP)

**What:** Mount `McpServer` from `@modelcontextprotocol/sdk` inside the existing Hono app, using `WebStandardStreamableHTTPServerTransport`. The SDK handles session management, SSE streaming, and JSON-RPC protocol.

**When to use:** Any Hono route needs to expose MCP-compatible tool calls.

**Example:**
```typescript
// Source: github.com/modelcontextprotocol/typescript-sdk README (Hono example)
// [VERIFIED: Context7 /modelcontextprotocol/typescript-sdk]
import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function buildMcpServer(pool: Pool): McpServer {
  const server = new McpServer({ name: 'graph-os', version: '1.0.0' });

  server.registerTool(
    'spawn_subtask',
    {
      description: 'Spawn a sub-task. Writes task_spawned event. Returns task_id.',
      inputSchema: z.object({
        required_skills: z.array(z.string()).min(1),
        scope_id: z.string().regex(UUID_V4),
        predecessor_hash: z.string().regex(HASH_HEX64),
        payload: z.record(z.string(), z.unknown()),
      }),
    },
    async ({ required_skills, scope_id, predecessor_hash, payload }) => {
      // Violation guard: D-1 — no assigned_agent_id allowed
      if ('assigned_agent_id' in payload || 'preferred_agent' in payload) {
        return { content: [{ type: 'text', text: 'REJECTED: explicit agent assignment forbidden (D-1)' }], isError: true };
      }
      // ... write task_spawned event with required_skills in payload
      return { content: [{ type: 'text', text: JSON.stringify({ task_id: entityId }) }] };
    },
  );
  return server;
}

// In gateway/src/routes/mcp.ts:
const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
await server.connect(transport);
app.all('/mcp', c => transport.handleRequest(c.req.raw, { parsedBody: await c.req.json().catch(() => undefined) }));
```

### Pattern 2: MCP Streamable HTTP Protocol (2025-11-25 spec)

**What:** Single `/mcp` endpoint, both GET and POST. GET opens SSE push stream. POST accepts JSON-RPC tool calls and returns JSON-RPC responses (optionally as SSE).

**When to use:** Phase 3 uses `/mcp/sse` (GET) and `/mcp/messages` (POST) per DESIGN.md. Map these to the standard `/mcp` endpoint via Hono routing aliases or mount the SDK transport at each path.

**Key protocol facts** [VERIFIED: Context7 /websites/modelcontextprotocol_io_specification_2025-11-25]:
- `GET /mcp` → server responds `Content-Type: text/event-stream`
- `POST /mcp` → client must include `Accept: application/json, text/event-stream`
- POST response can be JSON (202 for notifications) or SSE stream
- Server SHOULD prime SSE stream with an empty-data event immediately after connection
- Clients SHOULD use `Last-Event-ID` header for reconnection

**DESIGN.md endpoint mapping:**
| DESIGN.md path | MCP spec | SDK handles |
|---|---|---|
| `GET /mcp/sse` | GET /mcp | Yes — `WebStandardStreamableHTTPServerTransport` |
| `POST /mcp/messages` | POST /mcp | Yes — same transport |

Option: Mount transport at `/mcp` and add Hono aliases `/mcp/sse` → GET /mcp and `/mcp/messages` → POST /mcp. Or just route both DESIGN.md paths to the single transport's `handleRequest`.

### Pattern 3: CrossScopePatternDiscovery — SQL Clustering

**What:** Find `procedural_memory` pairs where topology is similar but intent is different. Use pgvector HNSW cosine distance operator `<=>`.

**When to use:** Inside `PatternDiscoveryWorker.runDiscovery()` after corpus guard passes.

**Example:**
```sql
-- Source: ADR 25 Phase 2 spec (verified in docs/adr/0027-adr25-cross-domain-topology-algorithm.md)
-- [CITED: docs/adr/0027-adr25-cross-domain-topology-algorithm.md]
SELECT
  a.id AS id_a,
  b.id AS id_b,
  1 - (a.topology_embedding <=> b.topology_embedding) AS cos_sim
FROM procedural_memory a
JOIN procedural_memory b ON a.id < b.id
WHERE a.topology_embedding IS NOT NULL
  AND b.topology_embedding IS NOT NULL
  AND a.topology_embedding <=> b.topology_embedding < 0.10   -- topology similar (cos > 0.90)
ORDER BY cos_sim DESC;
```

Then assign cluster IDs: pairs sharing no existing cluster_id get a new UUID; pairs overlapping an existing cluster inherit it (union-find in TypeScript).

### Pattern 4: GIN Index Skill Matching (FrontierScheduler extension)

**What:** Find agents in `agent_registry` whose `skills` TEXT[] overlaps with a task's `required_skills`. Use `&&` operator (array overlap) which uses the GIN index.

**When to use:** FrontierScheduler selects a top-K node AND needs to route it to a capable agent.

**Example:**
```sql
-- [ASSUMED] — this is the canonical PostgreSQL TEXT[] GIN pattern, not yet verified against live schema
SELECT agent_id, endpoint, protocol
FROM agent_registry
WHERE status = 'active'
  AND skills && $1::text[]   -- $1 = required_skills from task payload
  AND last_heartbeat > NOW() - INTERVAL '60 seconds'
ORDER BY RANDOM()   -- or by last_heartbeat DESC for recency
LIMIT 1
FOR UPDATE SKIP LOCKED;
```

### Pattern 5: sub_scope_resolved Injection (Control Plane extension)

**What:** Control Plane detects child `scope_closed`, reads `scope_lineage` for parent, direct-writes `sub_scope_resolved` to parent partition.

**Key constraint (ADR 23):** This event bypasses bus enum validation — Control Plane writes it directly, same as `context_oom_throttled`.

```typescript
// [CITED: docs/adr/0025-adr23-nested-scope-propagation.md]
// Control Plane (nesting.ts extension):
await pool.query(
  `INSERT INTO execution_event_log
     (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
   VALUES ($1, $2, 'sub_scope_resolved', $3,
     encode(digest($1||'|'||$2||'|'||$3||'|sub_scope_resolved|'||$4,'sha256'),'hex'),
     $4, 'pending_scheduling')`,
  [parentScopeId, entityId, predecessorHashInParent, JSON.stringify({
    child_scope_id: childScopeId,
    trigger_task_id: triggerTaskId,
    child_final_version_hash: childFinalHash,
  })],
);
```

### Anti-Patterns to Avoid

- **Assigning agent_id directly in task payload:** Violates D-1. FrontierScheduler is the sole assignment authority. Guard: Zod schema on `task_spawned` must reject `assigned_agent_id` field.
- **Writing sub_scope_resolved through the event bus enum:** ADR 12 only allows 5 canonical event types. `sub_scope_resolved` is a Control Plane direct-write, not a Worker-written event.
- **Storing task content in SSE push:** D-4 says push is trigger-only. SSE events carry no task payload — they only signal that a task is available.
- **Running CrossScopePatternDiscovery inline on scope_closed:** ADR 37 permanently abolishes this. Cron only, never inline.
- **Using topology_embedding alone for cluster identity:** Two templates from the same domain that are structurally identical would also cluster together. The cross-domain guard (`intent_embedding <=> b.intent_embedding > 0.5`) is required to ensure cross-domain discovery.
- **Mounting McpServer with a persistent stateful transport across all requests:** For Phase 3, stateless transport (`sessionIdGenerator: undefined`) is correct — each request is independent. Stateful session management (streaming mid-run) is Phase 4 scope.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| MCP JSON-RPC protocol | Custom JSON-RPC parser + SSE framing | `@modelcontextprotocol/sdk` `McpServer` | Session management, tool discovery, schema negotiation — ~600 LOC of protocol plumbing |
| SSE stream formatting | Custom `data: ...\n\n` writer | `streamSSE()` from `hono/streaming` | Handles retry, ID, event fields; used by SDK transport anyway |
| Cosine similarity search | In-memory Float32Array comparisons across N^2 pairs | pgvector `<=>` operator on HNSW index | Sub-millisecond similarity with pre-built index; O(log N) not O(N²) |
| Cluster ID assignment | Full DBSCAN/k-means | Simple union-find over HNSW pairs above threshold | ADR 25 spec: threshold-based pair clustering; no centroid needed |
| TEXT[] overlap query | Application-side skill filtering | `&&` operator with GIN index | Single SQL expression; GIN makes it O(log N); no result set loading |

**Key insight:** This phase's algorithms (WL kernel, cosine clustering, skill matching) are all in the "looks simple, has edge cases" category. The WL kernel is already implemented. The clustering is SQL + a 20-line union-find. Resist temptation to reach for graph libraries (Cayley, Peregrine) — the ADR 25 algorithm fits in two SQL queries and one TypeScript function.

---

## Issue #6 + #7 Resolution (G1 Traversal Algebra, G2 Pattern Definition Language)

These open research questions were flagged as blocking CrossScopePatternDiscovery design. Research finding:

**G1 (Traversal Algebra — Cayley/Gizmo):** Phase 3 does not need a general traversal algebra. The CrossScopePatternDiscovery query is a fixed pair-similarity SQL query with two conditions (topology cosine and intent distance). This fits in a single JOIN query using existing HNSW + pgvector. Cayley/Gizmo would be needed for open-ended graph queries ("find all paths matching pattern X") — a Phase 4+ concern. **Verdict for Phase 3: use pgvector SQL directly.** [ASSUMED — this is a judgment call based on Phase 3 scope, not a verified architectural decision]

**G2 (Pattern Definition Language — Peregrine):** Phase 3's `template_graph` JSONB field is populated by `MemorySynthesizerWorker` with a node/edge list structure (visible in `workers/src/index.ts` payload shape: `nodes: { id, event_type }[]`, `edges: { source, target }[]`). This is already a structured format. CrossScopePatternDiscovery does not need to parse `template_graph` at all — it only reads `topology_embedding vector(128)` and `intent_embedding` for clustering. Peregrine FSM would be needed if we wanted to enumerate subgraph instances in the raw event log, not in pre-embedded templates. **Verdict for Phase 3: existing node/edge list JSONB format is sufficient; no PDL needed.** [ASSUMED — judgment call, not verified against a definitive architectural authority]

Both issues can be closed as "resolved for Phase 3 scope; deferred if needed for Phase 4" with a brief note.

---

## Common Pitfalls

### Pitfall 1: HNSW index not used for cross-domain query
**What goes wrong:** The CrossScopePatternDiscovery query does a JOIN with `<=>` distance, but PostgreSQL may not use the HNSW index for JOIN conditions.
**Why it happens:** HNSW index in pgvector is only used for ORDER BY + LIMIT queries (ANN search), not for arbitrary JOIN filters.
**How to avoid:** Restructure as: for each template, use `ORDER BY topology_embedding <=> $1 LIMIT N` to find nearest neighbors, then filter by intent distance. Or use a two-pass approach: batch-load embeddings into TypeScript, compute cosine in-process for Phase 3 corpus size.
**Warning signs:** Slow query plan showing Seq Scan on procedural_memory during CrossScopePatternDiscovery.

### Pitfall 2: McpServer transport is per-request vs per-server
**What goes wrong:** If you create a new `McpServer + transport` per request, tool registrations are lost between calls. If you create one transport shared across all requests (stateful), concurrent requests share session state.
**Why it happens:** SDK design allows both; choosing wrong mode causes subtle failures.
**How to avoid:** For Phase 3 stateless design (`sessionIdGenerator: undefined`), create one `McpServer` (shared, with tools registered once), and one `WebStandardStreamableHTTPServerTransport` instance. The transport is stateless and safe to share. Tool registrations are on the McpServer, which is durable.
**Warning signs:** MCP client reports tool not found after second request.

### Pitfall 3: sub_scope_resolved bypasses bus enum — but iii-sdk may reject it
**What goes wrong:** `sub_scope_resolved` is a Control Plane direct-write that does NOT go through iii-sdk worker routing. If any code tries to `worker.registerFunction('graph::sub_scope_resolved', ...)` using iii-sdk with the event type name, iii may reject it as a non-canonical event type.
**Why it happens:** ADR 23 says CP writes directly to the DB partition, then the bus routes it by observing the row. SubScopeResultWorker subscribes via iii-sdk `durable:subscriber` on a topic — NOT on the event type directly.
**How to avoid:** SubScopeResultWorker registers as `durable:subscriber` on topic `graph::scope::sub_scope_resolved` (a custom topic, not an event type). Control Plane emits a pg-listen NOTIFY on `graph_event_ready` after writing; Pulse-Fetch routes to this topic rather than to `graph::scheduler::frontier`.
**Warning signs:** SubScopeResultWorker never receives events despite sub_scope_resolved rows being written to DB.

### Pitfall 4: FrontierScheduler skill-matching changes dispatch semantics for existing tasks
**What goes wrong:** After adding skill matching, existing tasks in `execution_event_log` without `required_skills` in payload get dispatched to no agent because all agents require a skill match.
**Why it happens:** Changing the dispatch query to require skill overlap breaks tasks that predate the agent_registry.
**How to avoid:** Make skill matching opt-in: only apply agent_registry lookup when `required_skills` is present in the payload. Tasks without `required_skills` dispatch via existing logic (any available slot).
**Warning signs:** All existing unit tests that don't set `required_skills` fail after FrontierScheduler extension.

### Pitfall 5: cross_domain_cluster_id UPDATE is a mutable write on procedural_memory
**What goes wrong:** `procedural_memory` is logically immutable (patterns are discovered, not edited). Writing `cross_domain_cluster_id` via UPDATE violates the append-only spirit.
**Why it happens:** ADR 25 specifies UPDATE for cluster assignment. The tension with immutability is acknowledged in ADR 37 (same pattern as `analyzed_for_patterns` flag).
**How to avoid:** Treat cluster assignment as processing metadata (same as `analyzed_for_patterns`). Use `UPDATE ... WHERE cross_domain_cluster_id IS NULL` to make re-runs idempotent — never overwrite an existing cluster assignment.
**Warning signs:** Re-running CrossScopePatternDiscovery creates multiple conflicting cluster IDs for the same template.

### Pitfall 6: topology_embedding HNSW partial index only covers non-anti-patterns
**What goes wrong:** The HNSW index on `procedural_memory.topology_embedding` has `WHERE is_anti_pattern = FALSE`. CrossScopePatternDiscovery accidentally excludes anti-patterns from cluster comparison, but the score comparison still works correctly in a self-join.
**Why it happens:** The partial index was designed for retrieval (find good patterns), not for discovery comparison.
**How to avoid:** For the CrossScopePatternDiscovery query, explicitly add `WHERE is_anti_pattern = FALSE` to both sides of the JOIN. The HNSW index will be used for the ANN search. Anti-patterns should not be clustered with good patterns.

---

## Code Examples

### CrossScopePatternDiscovery core algorithm
```typescript
// Source: ADR 25 Phase 2 spec
// [CITED: docs/adr/0027-adr25-cross-domain-topology-algorithm.md]
async function discoverClusters(pool: Pool): Promise<void> {
  // Fetch all un-clustered templates with embeddings
  const { rows } = await pool.query<{
    id: string;
    topology_embedding: string; // pgvector returns as '[0.1,0.2,...]' string
    intent_embedding: string;
  }>(
    `SELECT id, topology_embedding, intent_embedding
     FROM procedural_memory
     WHERE topology_embedding IS NOT NULL
       AND intent_embedding IS NOT NULL
       AND is_anti_pattern = FALSE
       AND cross_domain_cluster_id IS NULL`
  );

  // For each template, find neighbors with high topology similarity + low intent similarity
  const clusterMap = new Map<string, string>(); // id → cluster_id

  for (const row of rows) {
    if (clusterMap.has(row.id)) continue;

    const { rows: neighbors } = await pool.query(
      `SELECT id,
              1 - (topology_embedding <=> $1) AS cos_sim,
              intent_embedding <=> $1 AS intent_dist
       FROM procedural_memory
       WHERE topology_embedding IS NOT NULL
         AND intent_embedding IS NOT NULL
         AND is_anti_pattern = FALSE
         AND id != $2::uuid
         AND topology_embedding <=> $1 < 0.10   -- cos_sim > 0.90
         AND intent_embedding <=> $3 > 0.50     -- semantically different
       ORDER BY topology_embedding <=> $1
       LIMIT 50`,
      [row.topology_embedding, row.id, row.intent_embedding]
    );

    if (neighbors.length > 0) {
      const clusterId = randomUUID();
      clusterMap.set(row.id, clusterId);
      for (const n of neighbors) clusterMap.set(n.id, clusterId);
    }
  }

  // Bulk-write cluster assignments (idempotent: only set where null)
  for (const [id, clusterId] of clusterMap) {
    await pool.query(
      `UPDATE procedural_memory
       SET cross_domain_cluster_id = $1
       WHERE id = $2 AND cross_domain_cluster_id IS NULL`,
      [clusterId, id]
    );
  }
}
```

### Migration 007: agent_registry + cross_domain_cluster_id
```sql
-- [CITED: .harness/phases/side-branch/DESIGN.md §3.2]
-- Phase 3 migration: agent_registry table + cross_domain_cluster_id column

CREATE TABLE IF NOT EXISTS agent_registry (
  agent_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  skills          TEXT[] NOT NULL DEFAULT '{}',
  protocol        TEXT NOT NULL CHECK (protocol IN ('mcp', 'a2a', 'iii')),
  endpoint        TEXT,
  agent_card_json JSONB NOT NULL,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS idx_agent_registry_skills
  ON agent_registry USING GIN (skills);

CREATE INDEX IF NOT EXISTS idx_agent_registry_status_heartbeat
  ON agent_registry (status, last_heartbeat)
  WHERE status = 'active';

-- cross_domain_cluster_id: groups structurally equivalent templates across domains
ALTER TABLE procedural_memory
  ADD COLUMN IF NOT EXISTS cross_domain_cluster_id UUID;

CREATE INDEX IF NOT EXISTS idx_procedural_cross_domain_cluster
  ON procedural_memory (cross_domain_cluster_id)
  WHERE cross_domain_cluster_id IS NOT NULL;
```

### Hono SSE (streamSSE from hono/streaming)
```typescript
// Source: hono.dev/docs/helpers/streaming
// [VERIFIED: Context7 /websites/hono_dev]
import { streamSSE } from 'hono/streaming';

app.get('/mcp/sse', async (c) => {
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => {
      // Client disconnected — clean up pg-listen subscription
    });
    // SSE push: send signal (no task content per D-4)
    await stream.writeSSE({
      data: JSON.stringify({ type: 'task_available' }),
      event: 'graph_event_ready',
      id: String(Date.now()),
    });
  });
});
```

---

## State of the Art

| Old Approach | Current Approach | Status | Impact |
|--------------|------------------|--------|--------|
| MCP SSE-only transport (2024) | Streamable HTTP (2025-11-25 spec): single endpoint, GET=SSE, POST=JSON-RPC | Current spec | Phase 3 should use Streamable HTTP, not legacy SSE-only |
| McpServer v1 `server.tool()` | McpServer v2 `server.registerTool()` with `z.object()` inputSchema | Current in SDK 1.29.0 | Use `registerTool`, not deprecated `tool()` |
| WL kernel: 16-bit hash slice | 32-byte multi-segment projection (implemented in wl-embedding.ts) | Already fixed in Phase 2 | Phase 3 uses existing implementation |

**Deprecated/outdated:**
- `server.tool(name, schema, callback)` — v1 API, replaced by `server.registerTool()` in SDK 1.29.0
- MCP `2025-03-26` transport spec — superseded by `2025-11-25` Streamable HTTP spec

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | G1 traversal algebra (Cayley/Gizmo) is not needed for Phase 3 scope | Issue #6 Resolution | If wrong, CrossScopePatternDiscovery needs a graph query layer, adding ~1-2 plans |
| A2 | G2 pattern definition language (Peregrine) is not needed for Phase 3 | Issue #7 Resolution | If wrong, template_graph JSONB format needs redesign before clustering can work |
| A3 | `WebStandardStreamableHTTPServerTransport` is the correct transport for Hono (not `NodeStreamableHTTPServerTransport`) | MCP Patterns | If wrong, use NodeStreamableHTTPServerTransport + adapter; minor refactor |
| A4 | GIN TEXT[] `&&` operator correctly uses GIN index for skill matching | FrontierScheduler Pattern | If wrong, skill matching falls back to seq scan; acceptable for small agent_registry |
| A5 | SubScopeResultWorker subscribes via iii-sdk topic (not event_type), routed by Pulse-Fetch | Pitfall 3 | If wrong, requires new Pulse-Fetch routing logic; medium refactor |
| A6 | `intent_embedding` column exists on `procedural_memory` in Phase 2 schema | CrossScopePatternDiscovery | If wrong, cross-domain guard query fails; need to verify column exists |
| A7 | Heartbeat TTL of 60 seconds is appropriate for agent_registry staleness detection | Migration 007 | If too short, healthy agents get evicted; if too long, dead agents get tasks |

---

## Open Questions (RESOLVED)

1. **Does `procedural_memory` have an `intent_embedding` column?**
   - **RESOLVED by Plan 03-01:** Column does NOT exist in migrations 003 or 006. Migration 007 adds `intent_embedding vector(1536)` to procedural_memory. ProceduralMemoryWorker is extended to compute and write it on every template INSERT (nullable on provider failure).

2. **How does SubScopeResultWorker receive sub_scope_resolved — via iii-sdk topic or direct pg-listen?**
   - **RESOLVED by Plans 03-04 + 03-06:** SubScopeResultWorker uses a durable:subscriber on topic `graph::scope::sub_scope_resolved` (a custom topic string, not an event_type enum). Pulse-Fetch is extended in Plan 03-04 Task 2 to route rows with event_type='sub_scope_resolved' to this topic, bypassing the frontier topic.

3. **wait_all_tasks timeout behavior**
   - **RESOLVED by Plan 03-05:** On timeout, the tool returns an error object `{ timed_out: true, completed: string[], pending: string[] }`. Partial-completion return semantics deferred to Phase 4 per CONTEXT.md.

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `@modelcontextprotocol/sdk` | MCP Server layer | Not yet installed | 1.29.0 on npm | None — required for Stream B |
| pgvector `<=>` operator | CrossScopePatternDiscovery SQL | Enabled in migration 001-extensions.sql | postgres-compatible | None — required for Stream A |
| PostgreSQL GIN index on TEXT[] | agent_registry skill matching | Standard PostgreSQL feature | Any PG 12+ | None |
| `hono/streaming` | SSE push | Bundled with hono 4.12.23 | 4.12.23 | None |

**Missing dependencies with no fallback:**
- `@modelcontextprotocol/sdk` — must be installed before Stream B plans execute

**Missing dependencies with fallback:**
- None

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest ^2 |
| Config file | `vitest.config.mts` (root) |
| Quick run command | `vitest run` |
| Full suite command | `vitest run` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| GATE4-1 | Two topologically equivalent scopes have topology_embedding cosine > 0.90 | unit | `vitest run packages/workers/src/memory/wl-embedding.test.ts` | ❌ Wave 0 |
| GATE4-2 | CrossScopePatternDiscoveryWorker writes cross_domain_cluster_id | integration (skip without DB) | `vitest run packages/workers/src/patterns/cross-scope.test.ts` | ❌ Wave 0 |
| GATE4-3 | Nested scope: child scope_closed propagates to parent via sub_scope_resolved | integration (skip without DB) | `vitest run packages/control-plane/src/nesting.test.ts` | ❌ Wave 2 (created by Plan 03-04) |
| GATE4-4 | MCP client can call spawn_subtask + claim_next_task + complete_task | integration (skip without DB) | `vitest run packages/gateway/src/routes/mcp.test.ts` | ❌ Wave 0 |
| GATE4-5 | FrontierScheduler dispatches by skill match | unit | `vitest run packages/workers/src/scheduler/frontier.test.ts` | ❌ Wave 0 (extend existing) |

### Sampling Rate
- **Per task commit:** `vitest run`
- **Per wave merge:** `vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/workers/src/memory/wl-embedding.test.ts` — cosine similarity > 0.90 for structurally equivalent graphs (GATE4-1)
- [ ] `packages/workers/src/patterns/cross-scope.test.ts` — cluster assignment unit test (GATE4-2)
- [ ] `packages/gateway/src/routes/mcp.test.ts` — MCP tool call integration test (GATE4-4)
- [ ] `packages/workers/src/scheduler/frontier.test.ts` — extend with skill-matching test cases (GATE4-5)

---

## Project Constraints (from CLAUDE.md)

- **No features beyond what was asked.** Phase 3 scope is locked in CONTEXT.md. A2A full implementation is deferred to Phase 4.
- **Surgical changes.** FrontierScheduler extension must not change the priority formula — skill matching is an additional filter layer, not a replacement.
- **Immutable append-only writes.** `cross_domain_cluster_id` UPDATE is the explicitly accepted exception (same as `analyzed_for_patterns`); use idempotent `WHERE IS NULL` guard.
- **Harness discipline.** Write `.harness/implementation-notes.md` for Phase 3 decisions not covered by CONTEXT.md (e.g., SubScopeResultWorker routing mechanism, wait_all_tasks timeout return value).
- **State lives outside the agent.** All MCP session state (predecessor_hash tracking, scope_id) is maintained by the MCP adapter tools' DB queries, not in process memory.
- **No workflow layer.** The MCP tools (`spawn_subtask`, `claim_next_task`, etc.) are not a workflow engine — they are cognitive translation adapters over existing ledger operations.

---

## Sources

### Primary (HIGH confidence)
- `docs/adr/0027-adr25-cross-domain-topology-algorithm.md` — WL kernel algorithm, topology_embedding schema, CrossScopePatternDiscovery SQL
- `docs/adr/0025-adr23-nested-scope-propagation.md` — nested scope protocol, sub_scope_resolved, SubScopeResultWorker spec
- `docs/adr/0039-adr37-pattern-discovery-schedule.md` — cron schedule, corpus guard, OLAP/OLTP isolation
- `docs/adr/0033-adr31-frontier-scheduler-architecture.md` — FrontierScheduler priority SQL, dispatch protocol
- `docs/adr/0026-adr24-agent-entry-point-protocol.md` — HTTP Gateway spec, MCP adapter design
- Context7 `/modelcontextprotocol/typescript-sdk` — McpServer, registerTool(), WebStandardStreamableHTTPServerTransport, Hono integration
- Context7 `/websites/modelcontextprotocol_io_specification_2025-11-25` — MCP Streamable HTTP transport spec (GET/POST /mcp, SSE behavior)
- Context7 `/websites/hono_dev` — streamSSE(), onAbort(), SSE timeout handling
- `.harness/phases/side-branch/DESIGN.md` — D-1~D-7 decisions, agent_registry schema, endpoint table
- `packages/workers/src/memory/wl-embedding.ts` — existing WL kernel implementation (Phase 2)
- `packages/workers/src/memory/procedural.worker.ts` — existing ProceduralMemoryWorker with embedding pipeline
- `packages/workers/src/patterns/discover.worker.ts` — existing PatternDiscoveryWorker stub

### Secondary (MEDIUM confidence)
- `npm view @modelcontextprotocol/sdk` — version 1.29.0, published 2024-11-11, last modified 2026-06-04
- `slopcheck install @modelcontextprotocol/sdk` — OK (no slop flags)
- `migrations/003-memory-tables.sql` — confirmed topology_embedding vector(128) + HNSW index exist

### Tertiary (LOW confidence / assumed)
- A3: WebStandardStreamableHTTPServerTransport vs NodeStreamableHTTPServerTransport — based on Context7 docs showing Hono example, not tested in project
- A5: SubScopeResultWorker iii-sdk routing mechanism — inferred from Pulse-Fetch architecture
- A6: intent_embedding column existence — not confirmed in migration files reviewed

---

## Metadata

**Confidence breakdown:**
- Stream A algorithm: HIGH — WL kernel already implemented; CrossScopePatternDiscovery is 2 SQL queries + union-find
- Stream A nested scopes: HIGH — ADR 23 is fully specified with code examples
- Stream B MCP protocol: MEDIUM — verified against Context7; Hono integration example confirmed; actual runtime behavior not tested
- Stream B FrontierScheduler skill-matching: MEDIUM — GIN + && operator pattern is standard PostgreSQL; integration with dispatch loop is ASSUMED
- Stream B agent_registry: HIGH — schema is locked in DESIGN.md; standard PostgreSQL migration

**Research date:** 2026-06-05
**Valid until:** 2026-07-05 (MCP SDK updates frequently — re-verify if planning is delayed)
