# Local user-journey UAT — 2026-06-07

Live, end-to-end run against `npm run dev` (iii + workers + control-plane + gateway,
Postgres via docker compose). Not unit tests — real HTTP/MCP calls as a user/client would make them.

## 0. Environment stand-up — BLOCKED, then fixed live

`iii` (the engine all four services depend on) **crashed on boot** with the freshly-added
Phase 4 `iii-config.yaml` blocks. None of these had ever been run against the real engine —
04-UAT.md test #1 only "verified by reading the file," never booted it. Found and fixed
4 cascading config errors (each only surfaced after fixing the previous):

1. `iii-queue.config.adapter: builtin` → engine wants `adapter: { name: builtin }` (struct, not string)
2. `iii-pubsub.config.adapter: local` → same — needs `{ name: local }`
3. `iii-state.config.adapter: kv` + top-level `path:` → `path` is not a valid field here;
   needs `adapter: { name: kv, config: { store_method: file_based, file_path: ... } }`
4. `iii-exec.config.watch: src/**/*.ts` → `watch` must be a YAML sequence, not a bare string

After fixing 1–4, hit a 5th, structural issue:

5. **`iii-exec` is conceptually wrong, not just malformed.** Per the project's own
   `.harness/research/iii-engine.md`, `iii-exec` exists to *spawn and supervise external
   processes* (requires both `watch:` AND `exec: [<command sequence>]`). The config comment
   claimed it would "auto-restart Workers on TypeScript source change" — a different mechanism
   that `dev.mjs` already implements directly via `tsx`. No `exec` target was ever designed.
   Engine refuses to boot with `missing field 'exec'`. **Disabled the block** (commented out,
   with a note) rather than guess at a command — this needs a design decision, not a fix.

All 5 fixes are in `iii-config.yaml` (uncommitted). After block 5 was disabled, the full
stack boots clean: `iii engine listening on 0.0.0.0:4001` → workers register → `[control-plane]
boot complete` → `[gateway] gateway.ready port=4000`. `GET /v1/sys/health` → `{"engine_status":"ok"}`.

**Implication:** `04-UAT.md` test #1 ("iii-config.yaml structure... pass") was a false
positive — static structure matched the plan's (also-wrong) spec, but the spec itself was
never validated against the real engine. This is the textbook case UAT-by-actually-running
exists to catch.

## 1. MCP — `npx @modelcontextprotocol/inspector`

- **Default transport auto-detection fails (FIXED — see below)**: `inspector --cli
  http://localhost:4000/mcp/messages` → `Failed to connect to MCP server: SSE error: Non-200
  status code (404)`.
  - **Root-cause correction (the first hypothesis was wrong)**: this is *not* the inspector
    doing a protocol-level GET probe and getting confused by the SSE/messages split. Reading
    `inspector-cli/build/index.js` shows the `--cli` mode picks a transport purely from the
    **URL string**, with no server contact at all: `pathname.endsWith('/mcp')` → Streamable
    HTTP, `pathname.endsWith('/sse')` → legacy SSE, **anything else → legacy SSE** (a guess).
    `/mcp/messages` matches neither suffix, so this client *always* guesses legacy SSE against
    it — `SSEClientTransport` then does `GET /mcp/messages` expecting an `event: endpoint`
    SSE message, which 404s (no GET handler existed) → the observed error.
  - Confirmed this is genuinely a client-side heuristic limitation, not solvable by changing
    how the gateway routes `/mcp/messages` — adding `app.all` there to also accept GET just
    changes the failure to a hang (`SSE error: TypeError: fetch failed: other side closed`,
    legacy transport waiting forever for an `endpoint` event the modern transport never sends).
  - **Fix applied** (`packages/gateway/src/routes/mcp.ts`): added `/mcp` as a second path for
    the exact same JSON-RPC handler, alongside the existing `/mcp/messages` (kept for current
    callers/tests/docs). `/mcp` is both the MCP spec's own canonical single-endpoint convention
    (matches the SDK's reference example `honoWebStandardStreamableHttp.js`, `app.all('/mcp', …)`)
    *and* satisfies this client's URL-suffix guess. Purely additive — `GET /mcp/sse` (D-4's
    separate, intentionally-limited "availability signals only" channel) is untouched.
  - **Verified live, default auto-detection (no forced `--transport`)**:
    `inspector --cli http://localhost:4000/mcp --method tools/list` → connects cleanly,
    lists all 8 tools with full JSON schemas. Confirmed `/mcp/messages`, `/mcp/sse` both still
    work exactly as before (manual curl + forced-transport inspector runs).
  - *Side note*: while implementing, discovered Hono 4.12.23's array-path form
    `app.all(['/mcp', '/mcp/messages'], handler)` silently 404s on **both** paths (isolated
    with a standalone repro script — `app.get([...])` has the same bug, two separate
    `app.all(path, handler)` calls work fine). Used two registrations sharing one handler.
- With `--transport streamable-http` forced (or via the new `/mcp` URL): connects cleanly,
  lists 8 tools (`spawn_subtask`, `claim_next_task`, `get_task_status`, `complete_task`,
  `wait_all_tasks`, `register_agent`, `query_context`, plus one more), full JSON schemas present.
- `tools/call query_context` against a non-existent `scope_id` → clean graceful empty result
  `{"scope_id":"...","event_count":0,"events":[]}`, no crash. Sad-path handled correctly.

## 2. Memory retrieval — happy + sad paths

Sad paths (`GET /v1/memory/search`, `POST /v1/memory/reinforce`):
| Case | Result |
|---|---|
| missing `scope_id` | `400 {"error":"scope_id is required"}` ✓ |
| malformed UUID | `400 {"error":"scope_id must be a valid UUID v4"}` ✓ |
| empty query, valid scope | `{"results":[]}` ✓ |
| reinforce, missing `template_id` | `400 {"error":"template_id is required"}` ✓ |
| reinforce malformed JSON body | `400 {"error":"template_id is required"}` (caught, same message) ✓ |
| **reinforce, nonexistent `template_id`** | **`200 {"reinforced":true}` — FALSE POSITIVE** ✗ |

**Bug**: `packages/gateway/src/routes/memory.ts:81-89` runs
`UPDATE procedural_memory ... WHERE id = $1` and unconditionally returns `{reinforced: true}`
without checking `rowCount`. A client passing a stale/wrong `template_id` is told the
reinforcement succeeded when zero rows were touched.

Happy path: fresh DB ships with **zero seed data** (`semantic_memory` empty, no scopes).
Tested search against a real, freshly-created live scope (see §3) — correctly returns
`{"results":[]}` (no semantic memory yet; that requires scope closure → CrystallizeWorker,
out of scope for a single-event probe). Confirms the route is live and well-behaved; a true
"results returned" happy path needs a longer-running journey (create → execute → close → search).

## 3. Core graph execution — live, real

- `POST /v1/scopes {"intent":"..."}` → `201`, returns `scope_id`, SHA-256 `plan_hash`
  (`0c931aed...`), and assembled 3-layer context (stable/context/volatile). Real hash chain,
  real DDL nesting via Control Plane (ADR 24 — gateway has no direct DDL rights).
- `GET /v1/scopes/:id` → returns live state (`status: active`) and re-assembled context.
- `POST /v1/scopes/:id/events` — schema requires `entity_id` (UUID v4) + `predecessor_hash`
  (64-hex SHA-256, genesis = all-zeros) + `event_type` + `payload`; raw Zod errors are surfaced
  to the client (internal validation library leaking through the API — minor DX rough edge).
- Submitted a `task_spawned` event with a guessed genesis `predecessor_hash` →
  **OCC correctly detected the hash-chain mismatch and demoted the write to a
  `conflict_detected` entity** (`occ_result: "demoted"`), returning a fresh `version_hash`
  and the updated causal-chain context showing both `plan_created` and `conflict_detected`
  events in lineage order. This is the append-only, hash-chained, OCC-protected execution
  graph working exactly as designed — verified live, not mocked.

## 4. Logging system integrity

- `iii-observability` (sampling_ratio 0.1, logs_console_output: true) produces structured,
  leveled logs across all 4 services (`[iii]`, `[workers]`, `[ctrl]`, `[gateway]`), readable
  via `dev.mjs`'s pino-aware formatter.
- `scope.created` was logged with full structured fields (`scope_id`, `plan_hash`, `route`).
- **Gap**: the subsequent event submission — including the OCC conflict detection /
  demotion to `conflict_detected` — produced **no corresponding structured log line** at
  all (`grep -i "conflict|occ_result|demoted|event.submitted"` → nothing from the gateway/
  workers, only the static "Function graph::conflict-resolver REGISTERED" line from boot).
  A significant graph-mutation event — one that changes an entity's recorded type and
  triggers conflict resolution — happens silently from a logging-observer's perspective,
  even with `LOG_LEVEL=debug` set in `.env`.

## Summary of findings

| # | Area | Severity | Status |
|---|---|---|---|
| 1 | `iii-config.yaml`: 4 cascading struct/type errors block engine boot entirely | **Blocker** | Fixed live (uncommitted) |
| 2 | `iii-exec` block conceptually incomplete — needs design decision on `exec` target | Design gap | Disabled (uncommitted), needs a decision |
| 3 | MCP inspector / standard client auto-detection 404s against documented `/mcp/messages` URL | Medium — DX/spec-conformance | **Fixed live** — added `/mcp` alias path, verified default auto-detection now succeeds (uncommitted) |
| 4 | `POST /v1/memory/reinforce` reports success on no-op (nonexistent `template_id`) | Low-medium — silent false positive | Documented, not fixed |
| 5 | Raw Zod validation errors leak to API clients on `/v1/scopes/:id/events` | Low — DX rough edge | Documented, not fixed |
| 6 | OCC conflict-detection events produce no structured log output | Medium — observability gap | Documented, not fixed |

**Nothing in this run was fabricated or assumed** — every line above traces to an actual
command run against the live local stack today. Dev stack left running at the time of writing
(`http://localhost:4000`, `ws://localhost:4001`) for further exploration if wanted.
