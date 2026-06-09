<!-- generated-by: gsd-doc-writer -->
# @graph/gateway

Hono HTTP gateway: REST API + MCP Streamable HTTP server for agent entry into the causal execution graph.

Part of the [graph-engineering](../../README.md) monorepo.

## Installation

This package is private to the monorepo. Run from the repo root:

```bash
bun install
```

## Starting the server

```bash
bun run packages/gateway/src/index.ts
```

The server starts on `PORT` (default `3000`) and logs `gateway.ready` when ready.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DATABASE_URL` | No | `postgres://localhost:5432/graph` | PostgreSQL connection string |
| `PORT` | No | `3000` | HTTP listen port |
| `CONTEXT_W_MAX` | No | `4096` | Context window token budget |
| `LLM_BASE_URL` | No | `http://localhost:11434` | LLM provider base URL |
| `LLM_MODEL` | No | `llama3` | LLM model name |
| `LLM_API_KEY` | No | _(empty)_ | LLM API key |
| `GRAPH_RUNTIME_SECRET` | No | _(unset)_ | Bearer token required for `POST /pair/generate` when set |
| `REQUIRE_AGENT_PAIRING` | No | _(unset)_ | Set to `true` to require MCP callers to be paired |
| `EXECUTE_BASH_ENABLED` | No | _(unset)_ | Set to `true` to enable the `execute_bash` MCP tool |
| `EXECUTE_BASH_CWD` | No | `os.tmpdir()` | Working directory for `execute_bash` |

## REST endpoints

The gateway holds SELECT/INSERT rights only — DDL is owned exclusively by the Control Plane daemon (ADR 05, ADR 24).

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/scopes` | Create a new Scope (delegates DDL to Control Plane) |
| `POST` | `/v1/scopes/:id/events` | Submit an event (OCC + inline Watchdog + context assembly) |
| `GET` | `/v1/scopes/:id` | Read scope state and context window |
| `GET` | `/v1/scopes/:id/topology` | Trail Mesh graph (nodes + edges, max 500 nodes) |
| `GET` | `/v1/sys/health` | Engine health: live scopes, pool slots |
| `POST` | `/v1/agents/register` | Register an external agent's AgentCard |
| `GET` | `/.well-known/agent-card.json` | graph-os self-descriptor AgentCard (no DB) |
| `POST` | `/v1/memory/search` | Hybrid BM25 + vector semantic memory search |
| `POST` | `/pair/generate` | Generate an 8-character pairing code for an agent (admin-only) |
| `POST` | `/pair` | Verify a pairing code and mark the agent as paired |

## MCP server

Exposed at `/mcp` and `/mcp/messages` (JSON-RPC 2.0, MCP Streamable HTTP 2025-11-25). An SSE push stream is available at `/mcp/sse` (availability signals only; carries no task content per D-4).

Instances are stateless — a fresh server and transport are created per request.

### Tools

| Tool | Description |
|---|---|
| `spawn_subtask` | Write a `task_spawned` event to the causal ledger. D-1: `assigned_agent_id` / `preferred_agent` in payload are rejected; route by `required_skills` only. |
| `claim_next_task` | Atomically claim the next matching task using `FOR UPDATE SKIP LOCKED` (D-4 pull-primary). |
| `get_task_status` | Query the current status and latest `version_hash` for a task entity. |
| `complete_task` | Write a `memory_updated` event to mark a task done. Looks up `scope_id` and `predecessor_hash` from the ledger if omitted. |
| `wait_all_tasks` | Poll until all specified task IDs reach a terminal state, or until `timeout_s` (max 600 s). |
| `register_agent` | Upsert an external agent's AgentCard into `agent_registry`; refreshes `last_heartbeat` on conflict. |
| `query_context` | Return a causal-chain summary (recent events) for a given `scope_id`. |
| `execute_bash` | Execute a shell command on the host. Only registered when `EXECUTE_BASH_ENABLED=true`. Blocked commands are written as audit events to the causal ledger. |

## Agent pairing

When `REQUIRE_AGENT_PAIRING=true`, every MCP request must supply an `X-Agent-ID` header whose value has been paired via the `/pair` flow:

1. An admin calls `POST /pair/generate` (optionally guarded by `GRAPH_RUNTIME_SECRET` Bearer token) with `{ "agent_id": "<uuid>" }` to receive an 8-character code valid for 3600 s.
2. The agent calls `POST /pair` with `{ "agent_id": "<uuid>", "code": "<code>" }` to complete pairing.
3. Subsequent MCP requests include `X-Agent-ID: <uuid>`.

Pairing state is in-process memory only (single-process deployments). Multi-process support requires a PostgreSQL-backed `agent_pairing` table (future phase).

## Testing

```bash
bun test packages/gateway
```
