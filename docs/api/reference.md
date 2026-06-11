<!-- generated-by: gsd-doc-writer -->
# API Reference

The Gateway exposes a REST API (Hono 4, port 4000 by default) and an MCP endpoint (MCP Streamable HTTP, 2025-11-25 spec). All REST responses are JSON. All request bodies must include `Content-Type: application/json`.

---

## Authentication

Agent pairing is optional and controlled by the `REQUIRE_AGENT_PAIRING` environment variable.

**When `REQUIRE_AGENT_PAIRING=true`:**

Every request to the MCP endpoints (`/mcp`, `/mcp/messages`, `/mcp/sse`) must include the `X-Agent-ID` header containing a paired agent ID. Requests without a valid paired ID receive:

```json
HTTP 401
{ "error": "Agent not paired. POST /pair with your pairing code." }
```

**Pairing flow:**

1. An admin calls `POST /pair/generate` with a Bearer token equal to `GRAPH_RUNTIME_SECRET` to generate a one-time pairing code for a given `agent_id`.
2. The agent calls `POST /pair` with its `agent_id` and the code to mark itself as paired.
3. The agent includes `X-Agent-ID: <agent_id>` on subsequent MCP requests.

Codes expire after 3600 seconds. After 5 failed verification attempts the code is locked.

The REST endpoints (`/v1/*`, `/health`) are not gated by `REQUIRE_AGENT_PAIRING`.

---

## REST API

### POST /v1/scopes

Create a new Trail (Scope) in the causal ledger. Triggers the 3-phase DDL nesting protocol via the Control Plane and returns an assembled initial context.

**Request body**

| Field | Type | Required | Validation |
|---|---|---|---|
| `intent` | string | Yes | 1–4096 characters |

```json
POST /v1/scopes
Content-Type: application/json

{
  "intent": "Investigate performance regression in checkout flow"
}
```

**Success response — 201 Created**

```json
{
  "scope_id": "a1b2c3d4-e5f6-4789-ab01-cd2345ef6789",
  "plan_hash": "a3f1...64-char-hex",
  "context": {
    "events": [],
    "token_count": 0
  }
}
```

| Field | Type | Description |
|---|---|---|
| `scope_id` | string (UUID v4) | Stable identifier for this Trail; used as `:id` in subsequent requests |
| `plan_hash` | string (SHA-256 hex) | Hash of the `plan_created` root event; use as `predecessor_hash` for the first event write |
| `context` | object | Assembled Knapsack context (initially empty graph) |

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "..." }` | Zod validation failure (e.g. `intent` empty or > 4096 chars) |

---

### POST /v1/scopes/:id/events

Submit an event to an existing Trail. Runs the inline Convergence Watchdog (ADR 19 Tier 3) after the write. Returns a reassembled Knapsack context. When the scope converges and closes, `context` is `null` — the agent should terminate.

**Path parameter**

| Parameter | Type | Validation |
|---|---|---|
| `id` | string | UUID v4; validated before any DB access |

**Request body**

| Field | Type | Required | Validation |
|---|---|---|---|
| `event_type` | string (enum) | Yes | `"task_spawned"` or `"memory_updated"` |
| `entity_id` | string | Yes | UUID v4 |
| `predecessor_hash` | string | Yes | 64-char lowercase hex (SHA-256) |
| `payload` | object | Yes | Arbitrary key–value map |

`plan_created` and `scope_closed` are infrastructure events written only by the Gateway itself — agents may not submit them directly.

```json
POST /v1/scopes/a1b2c3d4-e5f6-4789-ab01-cd2345ef6789/events
Content-Type: application/json

{
  "event_type": "task_spawned",
  "entity_id": "f0e1d2c3-b4a5-4678-9012-ab3456cd7890",
  "predecessor_hash": "a3f1...64-char-hex",
  "payload": {
    "description": "Profile database queries",
    "required_skills": ["database", "profiling"]
  }
}
```

**Success response — 200 OK (scope active)**

```json
{
  "version_hash": "7c3b...64-char-hex",
  "occ_result": { "written": true },
  "context": {
    "events": [ ... ],
    "token_count": 512
  }
}
```

**Success response — 200 OK (scope closed — terminate signal)**

```json
{
  "version_hash": "7c3b...64-char-hex",
  "occ_result": { "written": true },
  "context": null
}
```

`context: null` means the scope has converged and closed. The agent receiving this response should terminate.

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "invalid scope_id: must be a UUID v4" }` | `:id` param is not UUID v4 |
| 400 | `{ "error": "..." }` | Zod validation failure on request body |
| 409 | `{ "error": "scope suspended", "scope_status": "suspended" }` | Scope is suspended; all writes are rejected (ADR 39) |

---

### GET /v1/scopes/:id

Read the current state and assembled Knapsack context for an existing Trail. Read-only; no writes are issued.

**Path parameter**

| Parameter | Type | Validation |
|---|---|---|
| `id` | string | UUID v4; validated before any DB access |

```
GET /v1/scopes/a1b2c3d4-e5f6-4789-ab01-cd2345ef6789
```

**Success response — 200 OK**

```json
{
  "scope_id": "a1b2c3d4-e5f6-4789-ab01-cd2345ef6789",
  "status": "active",
  "context": {
    "events": [ ... ],
    "token_count": 1024
  }
}
```

| Field | Type | Description |
|---|---|---|
| `scope_id` | string (UUID v4) | The requested scope identifier |
| `status` | string (enum) | `"active"`, `"closed"`, or `"suspended"` |
| `context` | object \| null | Assembled Knapsack context; `null` when scope is closed |

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "invalid scope_id: must be a UUID v4" }` | `:id` param is not UUID v4 |
| 404 | `{ "error": "scope not found" }` | No scope with the given ID exists |

---

### GET /v1/scopes/:id/topology

Return the Association graph (nodes and directed edges) for a Trail. Useful for visualising the causal structure of an execution. Truncated at 500 nodes.

**Path parameter**

| Parameter | Type | Validation |
|---|---|---|
| `id` | string | UUID v4 |

```
GET /v1/scopes/a1b2c3d4-e5f6-4789-ab01-cd2345ef6789/topology
```

**Success response — 200 OK**

```json
{
  "nodes": [
    { "id": "a3f1...hex", "entity_id": "f0e1...uuid", "event_type": "task_spawned" }
  ],
  "edges": [
    { "source": "a3f1...hex", "target": "7c3b...hex" }
  ],
  "truncated": false
}
```

| Field | Type | Description |
|---|---|---|
| `nodes` | array | Each node: `{ id: version_hash, entity_id, event_type }` |
| `edges` | array | Each edge: `{ source: predecessor_hash, target: version_hash }`. Edges from the zero hash (initial root) are omitted |
| `truncated` | boolean | `true` when the scope has more than 500 events; only the first 500 are returned |

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "invalid scope_id: must be a UUID v4" }` | `:id` param is not UUID v4 |
| 404 | `{ "error": "scope not found" }` | No scope with the given ID exists |

---

### GET /v1/memory/search

Search semantic memory for a given scope using hybrid RRF (vector + BM25) retrieval. Falls back to BM25-only if the embedding provider is unavailable. Returns up to 10 results.

**Query parameters**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `q` | string | Yes | Search query text |
| `scope_id` | string | Yes | UUID v4; filters results to this Trail |

```
GET /v1/memory/search?q=checkout+performance&scope_id=a1b2c3d4-e5f6-4789-ab01-cd2345ef6789
```

**Success response — 200 OK**

```json
{
  "results": [
    {
      "id": 42,
      "scope_id": "a1b2c3d4-e5f6-4789-ab01-cd2345ef6789",
      "content": "Database index on orders.created_at reduced query time by 80%.",
      "rrf_score": 0.0157
    }
  ]
}
```

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "scope_id is required" }` | `scope_id` query parameter missing |
| 400 | `{ "error": "scope_id must be a valid UUID v4" }` | `scope_id` fails UUID v4 regex |
| 500 | `{ "error": "internal server error" }` | Database failure |

---

### POST /v1/memory/reinforce

Increment the `reinforcement_count` and refresh `last_used_at` for a procedural memory template. Used by agents to signal that a Lesson was useful.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `template_id` | string | Yes | ID of the procedural memory record to reinforce |

```json
POST /v1/memory/reinforce
Content-Type: application/json

{ "template_id": "proc-memory-uuid-or-id" }
```

**Success response — 200 OK**

```json
{ "reinforced": true }
```

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "template_id is required" }` | `template_id` missing from body |
| 500 | `{ "error": "internal server error" }` | Database failure |

---

### POST /v1/agents/register

Register an external agent's AgentCard in the agent registry. Uses an upsert — if `agent_id` already exists the record is refreshed (heartbeat + status reset to `"active"`).

**Request body**

| Field | Type | Required | Validation |
|---|---|---|---|
| `agent_id` | string | No | UUID v4; auto-generated if omitted |
| `name` | string | Yes | Minimum 1 character |
| `description` | string | No | Free text |
| `skills` | string[] | Yes | At least 1 skill string |
| `protocol` | string | Yes | One of `"mcp"`, `"a2a"`, `"iii"` |
| `endpoint` | string | No | URL where this agent is reachable |
| `version` | string | No | Semantic version string |

```json
POST /v1/agents/register
Content-Type: application/json

{
  "name": "code-review-agent",
  "description": "Performs automated code review using AST analysis.",
  "skills": ["code-review", "static-analysis"],
  "protocol": "mcp",
  "endpoint": "http://agent-host:5001/mcp"
}
```

**Success response — 201 Created**

```json
{
  "success": true,
  "agent_id": "f0e1d2c3-b4a5-4678-9012-ab3456cd7890"
}
```

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 400 | `{ "error": "..." }` | Zod validation failure |
| 500 | `{ "error": "Failed to register agent", "detail": "..." }` | Database failure |

---

### GET /.well-known/agent-card.json

Return the graph-os runtime's own static AgentCard. No database access. Used by external orchestrators to discover this system's capabilities and endpoints.

```
GET /.well-known/agent-card.json
```

**Response — 200 OK**

```json
{
  "name": "graph-os",
  "description": "Causal execution graph runtime. Routes tasks, assembles context, persists cognitive state.",
  "skills": ["task-routing", "context-assembly", "memory-retrieval", "pattern-discovery"],
  "protocol": "mcp",
  "endpoint": "/mcp/messages",
  "version": "1.0",
  "protocols": ["mcp", "a2a"],
  "endpoints": {
    "mcp": "/mcp/messages",
    "a2a": "/a2a/rpc",
    "agent_card": "/.well-known/agent-card.json"
  }
}
```

---

### GET /v1/sys/health

Return the runtime health status, live scope counts, and connection pool metrics. Returns HTTP 503 if the database is unreachable.

```
GET /v1/sys/health
```

**Success response — 200 OK**

```json
{
  "engine_status": "ok",
  "live_scopes": 12,
  "suspended_count": 2,
  "slots": 10,
  "idle_slots": 7
}
```

| Field | Type | Description |
|---|---|---|
| `engine_status` | string | `"ok"` or `"degraded"` |
| `live_scopes` | number | Count of scopes with `status = 'active'` |
| `suspended_count` | number | Count of scopes with `status = 'suspended'` |
| `slots` | number | Total DB pool connections allocated |
| `idle_slots` | number | Idle DB pool connections |

**Degraded response — 503 Service Unavailable**

```json
{ "engine_status": "degraded" }
```

---

### POST /pair/generate

Admin-only endpoint. Generate a one-time pairing code for an agent. Gated by `GRAPH_RUNTIME_SECRET` — the caller must present `Authorization: Bearer <GRAPH_RUNTIME_SECRET>`. If `GRAPH_RUNTIME_SECRET` is not set, no auth check is performed.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | Yes | Identifier for the agent being paired |

```json
POST /pair/generate
Authorization: Bearer <GRAPH_RUNTIME_SECRET>
Content-Type: application/json

{ "agent_id": "my-agent-01" }
```

**Success response — 200 OK**

```json
{
  "code": "X7KQ2MFA",
  "expires_in_s": 3600
}
```

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 401 | `{ "error": "Unauthorized" }` | Missing or incorrect Bearer token when `GRAPH_RUNTIME_SECRET` is set |

---

### POST /pair

Verify a pairing code and mark the agent as paired. After a successful call the agent may present `X-Agent-ID` on MCP requests.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `agent_id` | string | Yes | The agent ID the code was generated for |
| `code` | string | Yes | The 8-character pairing code from `POST /pair/generate` |

```json
POST /pair
Content-Type: application/json

{
  "agent_id": "my-agent-01",
  "code": "X7KQ2MFA"
}
```

**Success response — 200 OK**

```json
{ "paired": true }
```

**Error responses**

| Status | Body | Cause |
|---|---|---|
| 401 | `{ "error": "expired" }` | Code was generated more than 3600 seconds ago |
| 401 | `{ "error": "locked" }` | More than 5 failed verification attempts for this agent |
| 401 | `{ "error": "invalid" }` | Code does not match or `agent_id` not found |

---

## MCP Interface

The Gateway implements the MCP Streamable HTTP transport (2025-11-25 spec). All tool calls are JSON-RPC 2.0 messages.

**Endpoints**

| Path | Method | Purpose |
|---|---|---|
| `/mcp` | `*` | Primary entry point (spec-canonical single-endpoint path) |
| `/mcp/messages` | `*` | Alias for `/mcp`; preserved for existing callers |
| `/mcp/sse` | `GET` | SSE push stream (availability signals only — carries no task content per D-4) |

Both `/mcp` and `/mcp/messages` accept all HTTP methods and route through the same `WebStandardStreamableHTTPServerTransport`. Each request creates a fresh stateless transport instance.

**JSON-RPC call format**

```json
POST /mcp
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "spawn_subtask",
    "arguments": { ... }
  }
}
```

**When `REQUIRE_AGENT_PAIRING=true`** add `X-Agent-ID: <paired-agent-id>` to every MCP request.

---

### Tool: spawn_subtask

Spawn a sub-task in the causal ledger. Writes a `task_spawned` event via OCC and returns the new `task_id`. Routing is exclusively by `required_skills` — explicit agent assignment is forbidden (D-1 LOCKED).

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `required_skills` | string[] | Yes | At least 1 skill string |
| `scope_id` | string | Yes | UUID v4 |
| `predecessor_hash` | string | Yes | 64-char lowercase hex |
| `payload` | object | No | Arbitrary key–value map; must NOT contain `assigned_agent_id` or `preferred_agent` |

**Return value**

```json
{ "task_id": "f0e1d2c3-b4a5-4678-9012-ab3456cd7890" }
```

**Error (D-1 guard)**

```json
{ "isError": true, "content": [{ "type": "text", "text": "REJECTED: explicit agent assignment forbidden (D-1). Use required_skills for routing." }] }
```

---

### Tool: claim_next_task

Atomically claim the next available `task_spawned` event matching the given skills. Uses `FOR UPDATE SKIP LOCKED` (D-4 pull-primary model). Returns the claimed task or an empty object `{}` if no matching task is available.

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `skills` | string[] | Yes | At least 1 skill string |
| `scope_id` | string | No | UUID v4; if provided, limits claims to this scope |

**Return value (task available)**

```json
{
  "task_id": "f0e1d2c3-b4a5-4678-9012-ab3456cd7890",
  "scope_id": "a1b2c3d4-e5f6-4789-ab01-cd2345ef6789",
  "payload": { "required_skills": ["database"], "status": "pending_scheduling" },
  "predecessor_hash": "7c3b...64-char-hex"
}
```

**Return value (no task available)**

```json
{}
```

---

### Tool: get_task_status

Query the current status and latest `version_hash` for a task entity.

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `task_id` | string | Yes | UUID v4 |

**Return value**

```json
{
  "status": "processing",
  "version_hash": "7c3b...64-char-hex",
  "scope_id": "a1b2c3d4-e5f6-4789-ab01-cd2345ef6789",
  "event_type": "task_spawned"
}
```

**Error**

```json
{ "error": "task not found", "task_id": "..." }
```

---

### Tool: complete_task

Mark a task as done by writing a `memory_updated` event to the causal ledger. If `scope_id` and `predecessor_hash` are omitted, they are looked up from the ledger automatically.

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `task_id` | string | Yes | UUID v4 |
| `result` | object | No | Result payload; merged with `{ status: "completed" }` |
| `scope_id` | string | No | UUID v4; looked up if omitted |
| `predecessor_hash` | string | No | 64-char hex; looked up if omitted |

**Return value**

```json
{ "done": true }
```

**Error**

```json
{ "error": "task not found", "task_id": "..." }
```

---

### Tool: wait_all_tasks

Wait for all specified tasks to reach a terminal state (`completed` or `done`). Polls every 2 seconds. Returns partial state on timeout.

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `task_ids` | string[] | Yes | At least 1 UUID v4; up to array length limit |
| `timeout_s` | number | No | Default `60`; range 1–600 seconds |

**Return value (all completed)**

```json
{ "timed_out": false, "completed": ["uuid1", "uuid2"], "pending": [] }
```

**Return value (timeout)**

```json
{ "timed_out": true, "completed": ["uuid1"], "pending": ["uuid2"] }
```

---

### Tool: register_agent

Register an external agent by storing its AgentCard in the `agent_registry` table. On conflict the existing record's heartbeat and status are refreshed.

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `agent_card` | object | Yes | AgentCard object (see below) |

**AgentCard object**

| Field | Type | Required | Validation |
|---|---|---|---|
| `agent_id` | string | No | UUID v4; auto-generated if omitted |
| `name` | string | Yes | Minimum 1 character |
| `description` | string | No | Free text |
| `skills` | string[] | Yes | At least 1 skill string |
| `protocol` | string | Yes | One of `"mcp"`, `"a2a"`, `"iii"` |
| `endpoint` | string | No | URL where this agent is reachable |
| `version` | string | No | Semantic version string |

**Return value**

```json
{ "registered": "f0e1d2c3-b4a5-4678-9012-ab3456cd7890" }
```

**Error**

```json
{ "error": "DB error message" }
```

---

### Tool: query_context

Read a causal-chain summary for a given scope. Returns the most recent events scoped to `scope_id` only.

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `scope_id` | string | Yes | UUID v4 |
| `limit` | number | No | Default `20`; range 1–100 |

**Return value**

```json
{
  "scope_id": "a1b2c3d4-e5f6-4789-ab01-cd2345ef6789",
  "event_count": 3,
  "events": [
    {
      "entity_id": "f0e1...uuid",
      "event_type": "task_spawned",
      "version_hash": "7c3b...hex",
      "status": "processing",
      "created_at": "2026-06-09T10:00:00.000Z"
    }
  ]
}
```

---

### Tool: execute_bash

Execute a bash command on the host. Only available when `EXECUTE_BASH_ENABLED=true`. All commands pass through the CommandGate — hardline-blocked commands are rejected immediately; dangerous commands require runtime console approval. Blocked attempts are written to the causal ledger as audit events.

**Input schema**

| Field | Type | Required | Validation |
|---|---|---|---|
| `command` | string | Yes | 1–4096 characters |
| `scope_id` | string | Yes | UUID v4 |
| `predecessor_hash` | string | Yes | 64-char lowercase hex |

**Return value (success)**

```json
{ "stdout": "...", "stderr": "", "exit_code": 0 }
```

**Return value (non-zero exit)**

```json
{ "stdout": "...", "stderr": "error message", "exit_code": 1 }
```

**Error (command blocked)**

```
BLOCKED (hardline): <reason>. Cannot execute.
```
or
```
BLOCKED (requires approval): <reason>. Use the graph runtime console to approve.
```

---

## Error Envelope

All REST error responses share a consistent shape:

```json
{ "error": "human-readable message" }
```

Some errors include an additional `detail` field with a lower-level diagnostic (e.g. database error text).

**Common HTTP status codes**

| Code | Meaning |
|---|---|
| 400 | Zod validation failure — request body or path parameter is malformed |
| 401 | Authentication failure — missing or invalid pairing credentials |
| 404 | Resource not found — scope or entity does not exist |
| 409 | Conflict — scope is suspended; no writes accepted |
| 500 | Internal server error — database or dependency failure |
| 503 | Service unavailable — database unreachable (health check only) |

MCP JSON-RPC errors use the standard JSON-RPC 2.0 error envelope:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": { "code": -32603, "message": "Internal error description" }
}
```
