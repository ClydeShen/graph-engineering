# Phase 6 Plan — External Integrations & Runtime Extensions

**Phase goal:** Expand the graph runtime from a passive ledger+worker system into an interactive, multi-surface agent platform — consumable via messaging apps, capable of executing sandboxed code, aware of the user across scopes, and secure for multi-user deployments.

**Source:** Gap analysis at `.harness/analysis/hermes-graph-comparison.md` (Category 1 P2 + Category 2 P2–P4). Reference implementation: `D:\Repo\specimens\hermes-agent`.

**Prerequisites:** Phase 5 complete (AnthropicProvider, CommandGate, skill export, webhook notify).

**Wave structure:**

| Wave | Tasks | Rationale |
|------|-------|-----------|
| 1 | T1 McpClientWorker, T2 execute_bash MCP tool | Independent; T1 is read-only addition, T2 depends on CommandGate (Phase 5 T2) |
| 2 | T3 Messaging gateway (Telegram + Discord), T4 UserProfileWorker | T3 depends on webhook notify (Phase 5 T4) for routing context; T4 depends on mature Crystal stream |
| 3 | T5 DM pairing, T6 Graph inspection TUI | T5 depends on T3 gateway; T6 is standalone |
| 4 | T7 Manual verification checkpoint | Depends on T1–T6 |

---

## Task 1: McpClientWorker — consume external MCP servers

**Type:** feature  
**Effort:** 0.3 context window  
**Wave:** 1

### Goal

Add an `McpClientWorker` that connects to one or more external MCP servers (configured via `MCP_SERVER_URLS`) and registers their tools as callable `iii` functions within the graph runtime. Every tool call is recorded as a `memory_updated` hyper-edge with full causal lineage — external tool results become first-class graph events.

### Context

Hermes runs MCP servers on a dedicated background asyncio event loop (`tools/mcp_tool.py`). Their tools appear as native agent tools. The graph runtime currently IS an MCP server (outbound only). This task adds the inbound consumer path.

The `@modelcontextprotocol/sdk` is already installed (used by the MCP server in `packages/gateway`). The client-side classes (`Client`, `StdioClientTransport`, `StreamableHTTPClientTransport`) are in the same package.

Reference: MCP spec at `modelcontextprotocol.io/specification/2025-06-18/server/tools` — tools exposed via JSON-RPC `tools/call`.

### Acceptance criteria

- [ ] New file `packages/workers/src/integrations/mcp-client.worker.ts` exports `McpClientWorker` class and `MCP_CLIENT_TRIGGER_CONFIG` constant
- [ ] `MCP_CLIENT_TRIGGER_CONFIG = { type: 'scheduled', function_id: 'graph::integration::mcp-client', config: { cron: '@startup' } }` — runs once at worker startup to connect
- [ ] `McpClientWorker` constructor: `constructor(private readonly pool: Pool)`
- [ ] `McpClientWorker.connect()`: reads `MCP_SERVER_URLS` env var (comma-separated HTTP URLs); for each URL creates a `StreamableHTTPClientTransport` and a `Client`; calls `client.connect(transport)`; calls `client.listTools()` to discover available tools; registers each discovered tool as a named iii function `graph::mcp-ext::<serverHost>::<toolName>`
- [ ] Each registered function, when called with `{ args: Record<string, unknown> }`, calls `client.callTool({ name: toolName, arguments: args })` and writes the result as `occWrite({ eventType: 'memory_updated', payload: { mcp_server: serverUrl, tool: toolName, args, result } })`
- [ ] `MCP_SERVER_URLS` not set → `connect()` is a no-op (no error)
- [ ] Worker registered in `packages/workers/src/index.ts`
- [ ] New test `packages/workers/src/integrations/mcp-client.worker.test.ts` covers: no-op when `MCP_SERVER_URLS` unset; tool discovery mocked (mock `Client.listTools` returns 2 tools); tool call mocked (mock `Client.callTool` returns `{ content: [{ type: 'text', text: 'result' }] }`); `occWrite` called with correct payload

### Files

- `packages/workers/src/integrations/mcp-client.worker.ts` — new file
- `packages/workers/src/integrations/mcp-client.worker.test.ts` — new test file
- `packages/workers/src/index.ts` — register `McpClientWorker`

### Implementation notes

Use `StreamableHTTPClientTransport` (Streamable HTTP) not `StdioClientTransport` — the external servers are network-accessible, not subprocess-managed. The transport constructor takes `{ url: URL }`.

The `occWrite` call for each tool result needs a `scopeId` and `predecessorHash`. Since tool calls happen outside a specific scope context, use a dedicated "integration scope" entity: at startup, upsert a scope entity with a stable UUID derived from `createHash('sha256').update('mcp-integration-scope').digest('hex').slice(0, 32)` → format as UUID. This keeps all external tool calls in one auditable scope.

Each external MCP server connection failure should be caught and logged (not thrown) — partial connectivity is acceptable. Workers continue even if one server is unreachable.

---

## Task 2: execute_bash MCP tool with CommandGate

**Type:** feature  
**Effort:** 0.3 context window  
**Wave:** 1

### Goal

Add an `execute_bash` tool to the MCP server that allows registered agents to request bash command execution. All commands pass through `CommandGate` (Phase 5) before execution. Hardline-blocked commands are rejected immediately; dangerous commands are rejected with explanation (Phase 6 does not add LLM smart approval — that is a future phase).

### Context

Hermes `SANDBOX_ALLOWED_TOOLS` (7 tools at `tools/code_execution_tool.py:61–68`) includes `terminal`. The current graph runtime MCP server has no execution tool. `CommandGate.checkCommand()` from Phase 5 is the pre-execution safety check.

Phase 5 added the CommandGate hook comment in `packages/gateway/src/mcp/server.ts`. This task wires it.

### Acceptance criteria

- [ ] `packages/gateway/src/mcp/server.ts` registers an 8th tool: `execute_bash`
- [ ] `execute_bash` input schema: `{ command: z.string().min(1).max(4096), scope_id: z.string().regex(UUID_V4), predecessor_hash: z.string().regex(HASH_HEX64) }`
- [ ] Tool handler calls `checkCommand(command)` before any execution:
  - `{ allowed: false, tier: 'hardline' }` → return `{ isError: true, content: [{ type: 'text', text: 'BLOCKED (hardline): <reason>. Cannot execute.' }] }`
  - `{ allowed: false, tier: 'dangerous' }` → return `{ isError: true, content: [{ type: 'text', text: 'BLOCKED (requires approval): <reason>. Use the graph runtime console to approve.' }] }`
  - `{ allowed: true }` → execute via `child_process.exec` with `{ timeout: 30000, maxBuffer: 512 * 1024 }`
- [ ] Execution result (stdout, stderr, exit code) is written to the graph as `occWrite({ eventType: 'memory_updated', payload: { command, stdout, stderr, exit_code } })` using the supplied `scope_id` and `predecessor_hash`
- [ ] Returns `{ content: [{ type: 'text', text: JSON.stringify({ stdout, stderr, exit_code }) }] }` on success
- [ ] On execution error (timeout, maxBuffer exceeded): returns `{ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: msg }) }] }`
- [ ] New test `packages/gateway/src/routes/mcp.test.ts` adds cases: hardline blocked command returns isError; dangerous blocked command returns isError; safe command mocks exec and returns stdout
- [ ] `EXECUTE_BASH_ENABLED` env var (boolean, default `false`) — tool is only registered when this is `true`. This prevents accidental execution in environments where it's not intended.

### Files

- `packages/gateway/src/mcp/server.ts` — add `execute_bash` tool (conditional on `EXECUTE_BASH_ENABLED`)
- `packages/gateway/src/routes/mcp.test.ts` — add 3 new test cases

### Implementation notes

`child_process.exec` is Node.js built-in — no new dependency. Use the promisified form: `util.promisify(exec)`. Wrap in try-catch to catch timeout and buffer errors.

Do not implement Docker isolation in this task — that is T3 in Phase 6 original scope. Plain `exec` with CommandGate is the safe baseline; Docker backend is an upgrade path.

The `EXECUTE_BASH_ENABLED` guard is important: the MCP server is network-accessible. Default-off prevents unintended remote code execution in deployments that don't need it.

---

## Task 3: Messaging gateway — Telegram + Discord

**Type:** feature  
**Effort:** 0.5 context window  
**Wave:** 2

### Goal

Create `packages/gateway-bot` — a messaging gateway that lets users interact with the graph runtime via Telegram and Discord. Incoming messages trigger task spawns; Crystal/Lesson notifications are delivered back to the originating chat. Modelled after hermes `GatewayRunner` + `PlatformRegistry` pattern but scoped to two platforms only.

### Context

Hermes `GatewayRunner` at `gateway/run.py:1676` manages 20+ platforms. Session routing via `build_session_key()` at `gateway/session.py:600`. Telegram uses long-polling (`gateway/platforms/telegram.py:1489`) when `TELEGRAM_WEBHOOK_URL` is not set; webhook mode when it is. Discord uses webhooks for outbound, slash commands for inbound. `PlatformRegistry` singleton at `gateway/platform_registry.py:260`.

### Acceptance criteria

- [ ] New package `packages/gateway-bot/` with structure:
  ```
  packages/gateway-bot/
    src/
      adapters/
        telegram.ts      ← long-poll adapter
        discord.ts       ← interaction + webhook adapter
      session.ts         ← build_session_key equivalent
      router.ts          ← message → task_spawned dispatch
      index.ts           ← GatewayBot entrypoint
    package.json
    tsconfig.json
  ```
- [ ] `session.ts` exports `buildSessionKey(platform: 'telegram' | 'discord', chatId: string): string` → returns `${platform}::${chatId}`
- [ ] `router.ts` exports `dispatchMessage(sessionKey: string, text: string, pool: Pool): Promise<string>` — calls `occWrite` with `event_type: 'task_spawned'`, `payload: { source: sessionKey, text, required_skills: ['message-handler'] }`, returns `task_id`
- [ ] `adapters/telegram.ts`:
  - Long-poll mode (default): `startLongPoll(token: string, onMessage: (chatId: string, text: string) => Promise<string>)` — calls `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}` in a loop; passes each message to `onMessage`; sends reply via `sendMessage`
  - Webhook mode: `startWebhook(token: string, webhookUrl: string, port: number, onMessage: ...)` — registers webhook URL via `setWebhook`, listens on `port` for POST updates
  - Mode selected by `TELEGRAM_WEBHOOK_URL` env var (set → webhook, unset → long-poll)
- [ ] `adapters/discord.ts`:
  - Outbound: `sendToDiscord(webhookUrl: string, content: string): Promise<void>` — POST to Discord webhook URL
  - Inbound: Discord slash command setup (register `/graph` command via Discord REST API on startup; handle interactions via Express or Hono listener on `DISCORD_PORT`)
- [ ] `index.ts` GatewayBot: reads `TELEGRAM_BOT_TOKEN`, `DISCORD_WEBHOOK_URL`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID` env vars; starts configured adapters; wires `notify` (Phase 5 T4) to deliver Crystals/Lessons to the originating chat via `router.ts` session map
- [ ] `packages/gateway-bot/package.json` `"name": "@graph/gateway-bot"`, `"dependencies": { "@graph/shared": "workspace:*", "hono": "^4" }`
- [ ] Telegram adapter test: mock `getUpdates` response; verify `dispatchMessage` called; verify `sendMessage` reply sent
- [ ] Discord adapter test: mock Discord webhook POST; verify 200 response

### Files

- `packages/gateway-bot/src/adapters/telegram.ts` — new
- `packages/gateway-bot/src/adapters/discord.ts` — new
- `packages/gateway-bot/src/session.ts` — new
- `packages/gateway-bot/src/router.ts` — new
- `packages/gateway-bot/src/index.ts` — new
- `packages/gateway-bot/package.json` — new
- `packages/gateway-bot/tsconfig.json` — new
- `packages/gateway-bot/src/adapters/telegram.test.ts` — new
- `packages/gateway-bot/src/adapters/discord.test.ts` — new

### Implementation notes

Telegram long-poll pattern: maintain an `offset` that advances past each processed update ID. Set `timeout=30` on `getUpdates` so the connection holds open rather than polling repeatedly. The loop is: `getUpdates(offset, timeout=30)` → process updates → `offset = last_update_id + 1` → repeat. On network error: catch, log, sleep 5s, retry.

Discord inbound slash commands require app registration (done once via `PUT /applications/{app_id}/commands`) and an interaction endpoint verified by Discord (HMAC-SHA256 signature check). Wire the signature check middleware first — Discord will reject unverified endpoints. Use `DISCORD_PUBLIC_KEY` env var for verification.

The gateway-bot does not need a database connection for sending messages — only `router.ts` (which dispatches tasks) needs the pool. Pass pool into `GatewayBot` constructor.

---

## Task 4: UserProfileWorker — cross-scope user entity synthesis

**Type:** feature  
**Effort:** 0.3 context window  
**Wave:** 2

### Goal

Add a `UserProfileWorker` that periodically synthesizes a user profile entity in the graph by reading Crystals across all scopes for a given user entity. Modelled after hermes's Honcho integration (dialectic user modeling) but implemented entirely within the graph paradigm — no external dependency.

### Context

Hermes integrates Honcho (`plastic-labs/honcho`) for user modeling via "dialectic reasoning" across sessions (`honcho.dev` confirms hermes integration). The graph already stores all episodic traces — the data for user modeling exists. What's missing is a worker that reads Crystals across scopes and synthesizes a cross-scope user entity.

`CrystallizeWorker` writes Crystal entities (`event_type: 'memory_updated'`, `payload.source: 'crystallize'`). These are the raw material for user profiling.

### Acceptance criteria

- [ ] New file `packages/workers/src/memory/user-profile.worker.ts` exports `UserProfileWorker` and `USER_PROFILE_TRIGGER_CONFIG`
- [ ] `USER_PROFILE_TRIGGER_CONFIG = { type: 'scheduled', function_id: 'graph::memory::user-profile', config: { cron: '0 3 * * *' } }` — runs at 3AM daily (after the 2AM synthesizer)
- [ ] `UserProfileWorker` constructor: `constructor(private readonly pool: Pool, private readonly llm: LLMProvider)`
- [ ] `UserProfileWorker.synthesize(userId: string)`:
  1. Queries all Crystal events for `userId` across scopes: `SELECT payload FROM execution_event_log WHERE entity_id = $1 AND (payload::jsonb->>'source') = 'crystallize' ORDER BY created_at DESC LIMIT 50`
  2. If fewer than 3 Crystals, returns `{ skipped: true }` (insufficient data)
  3. Concatenates Crystal content; calls `llm.chat([{ role: 'system', content: 'Synthesize a concise user profile from these execution Crystals. Focus on: working patterns, tool preferences, recurring challenges, effective strategies. 3-5 bullet points max.' }, { role: 'user', content: combined }])`
  4. Writes user profile as `occWrite({ scopeId: USER_PROFILE_SCOPE_ID, entityId: userId, eventType: 'memory_updated', payload: { profile: llmOutput, source: 'user-profile', user_id: userId, crystal_count: rows.length } })`
- [ ] `USER_PROFILE_SCOPE_ID` is a stable UUID constant: `'00000000-0000-4000-8000-000000000001'` (dedicated user-profile scope, never mixed with task scopes)
- [ ] Scheduled handler reads all known user entity IDs from `agent_registry` where `protocol = 'human'` (future: from a `users` table); for each, calls `synthesize(userId)` sequentially
- [ ] Worker registered in `packages/workers/src/index.ts`
- [ ] New test `packages/workers/src/memory/user-profile.worker.test.ts` covers: skipped when fewer than 3 Crystals; `llm.chat` called with correct messages when ≥ 3 Crystals; `occWrite` called with correct scope and payload

### Files

- `packages/workers/src/memory/user-profile.worker.ts` — new file
- `packages/workers/src/memory/user-profile.worker.test.ts` — new test file
- `packages/workers/src/index.ts` — register `UserProfileWorker`

### Implementation notes

`USER_PROFILE_SCOPE_ID` must be pre-inserted into the graph scope table at startup (similar to the existing AgentCard upserts in `index.ts`) so `occWrite` can reference it as a valid foreign key. Add to the boot-time INSERT block:
```sql
INSERT INTO execution_event_log (scope_id, entity_id, event_type, version_hash, status, payload)
VALUES ('00000000-0000-4000-8000-000000000001', gen_random_uuid(), 'scope_initialized',
        encode(sha256('user-profile-scope'), 'hex'), 'completed', '{"scope":"user-profiles"}')
ON CONFLICT DO NOTHING;
```

The `payload::jsonb->>'source' = 'crystallize'` filter relies on Crystal payloads having `source: 'crystallize'` — this is already set in `CrystallizeWorker.onScopeClosed()`.

---

## Task 5: Cryptographic agent pairing

**Type:** feature  
**Effort:** 0.2 context window  
**Wave:** 3

### Goal

For multi-user graph runtime deployments, require each new MCP client connection to present a valid pairing code before it can write to the graph. Modelled after hermes DM pairing (`gateway/pairing.py`): SHA-256 + 16-byte random salt, 1hr TTL, 5-attempt lockout.

### Context

Hermes `gateway/pairing.py`: `CODE_TTL_SECONDS = 3600`, `MAX_FAILED_ATTEMPTS = 5`, SHA-256 + random salt, 0o600 file perms, short alphanumeric code delivered to the user via chat. Current MCP server uses optional `GRAPH_RUNTIME_SECRET` Bearer token — flat shared secret, no per-agent trust establishment.

This task adds per-agent pairing ON TOP of the existing Bearer token (which remains the primary auth). Pairing is only required when `REQUIRE_AGENT_PAIRING=true`.

### Acceptance criteria

- [ ] New file `packages/gateway/src/auth/pairing.ts` exports:
  - `generatePairingCode(agentId: string): { code: string; expiresAt: number }` — generates 8-char alphanumeric code; stores `{ hash: sha256(code + salt), salt: randomBytes(16).toString('hex'), agentId, createdAt: Date.now(), failedAttempts: 0 }` in an in-memory `Map<string, PairingEntry>`; returns code + TTL
  - `verifyPairingCode(agentId: string, code: string): { ok: true } | { ok: false; reason: 'expired' | 'locked' | 'invalid' }` — checks TTL, failed attempts, HMAC
  - `isPaired(agentId: string): boolean` — true if agent has a verified pairing record
- [ ] `TTL_SECONDS = 3600`, `MAX_FAILED_ATTEMPTS = 5` as constants
- [ ] `packages/gateway/src/routes/mcp.ts` middleware: if `REQUIRE_AGENT_PAIRING=true`, extract `X-Agent-ID` header; call `isPaired(agentId)` — if false, return HTTP 401 with `{ error: 'Agent not paired. POST /pair with your pairing code.' }`
- [ ] New route `POST /pair` in `packages/gateway/src/index.ts`: body `{ agent_id: string, code: string }`; calls `verifyPairingCode`; on `{ ok: true }` marks agent as paired and returns `{ paired: true }`; on failure increments counter and returns 401
- [ ] New route `POST /pair/generate` (admin-only, gated by `GRAPH_RUNTIME_SECRET` header): body `{ agent_id: string }`; calls `generatePairingCode`; returns `{ code, expires_in_s: 3600 }` — operator displays this code to the user via their preferred channel
- [ ] Tests: code generation returns 8-char alphanumeric; expired code returns `reason: 'expired'`; 5 failed attempts returns `reason: 'locked'`; correct code returns `{ ok: true }`

### Files

- `packages/gateway/src/auth/pairing.ts` — new file
- `packages/gateway/src/auth/pairing.test.ts` — new test file
- `packages/gateway/src/routes/mcp.ts` — add pairing middleware (conditional on `REQUIRE_AGENT_PAIRING`)
- `packages/gateway/src/index.ts` — register `/pair` and `/pair/generate` routes

### Implementation notes

The pairing `Map` is in-process memory — not persisted to PostgreSQL. On restart, all pairings are lost and agents must re-pair. This is intentional: hermes uses a 1hr TTL file with 0o600 perms; in-process Map with process-scoped lifetime is equivalent security for Phase 6. Persistent pairing (PostgreSQL-backed) is a future phase concern.

SHA-256 verification: `createHash('sha256').update(code + salt).digest('hex')` must match stored hash. Never store the raw code.

---

## Task 6: Graph inspection TUI ~~[SUPERSEDED]~~

> ⚠️ **2026-06-09 SUPERSEDED** — Graph visualization belongs to MemexShell Dashboard (REST polling, not a standalone TUI). MemexTerminal is the only TUI entrypoint and belongs to a future MemexShell phase, not Phase 6. See ROADMAP.md 北极星 for the locked decision. **Do not implement this task.**

**Type:** ~~feature~~ SUPERSEDED  
**Effort:** ~~0.3 context window~~ N/A  
**Wave:** ~~3~~ —

### ~~Goal~~

~~Add a `packages/tui` package with a minimal read-only terminal UI for browsing the execution graph, inspecting discovered patterns (Lessons/Skills), and monitoring worker status. No mutation — observation only.~~

### Context

Hermes uses `prompt_toolkit` (`hermes_cli/cli.py:HermesCLI`) with multiline editing, autocomplete, 60+ slash commands. The graph runtime needs a simpler browser-style TUI, not a full CLI. Node.js equivalent: `@inquirer/prompts` for interactive menus + `blessed` or raw terminal output for live data.

### Acceptance criteria

- [ ] New package `packages/tui/` with structure:
  ```
  packages/tui/
    src/
      views/
        graph.ts       ← recent events view
        patterns.ts    ← lessons/skills view
        agents.ts      ← agent registry view
      index.ts         ← TUI entrypoint (main menu)
    package.json
    tsconfig.json
  ```
- [ ] Main menu (via `@inquirer/select`): `[ Graph Events | Patterns & Skills | Agent Registry | Quit ]`
- [ ] **Graph Events view** (`graph.ts`): fetches `GET /api/scopes` and `GET /api/memory` from graph runtime; renders table with columns `scope_id (truncated)`, `event_type`, `status`, `created_at`; refreshes every 5s; press `q` to return to menu
- [ ] **Patterns & Skills view** (`patterns.ts`): reads `SKILLS_DIR` directory; lists all `SKILL.md` files with their `name` and `description` from YAML frontmatter; press Enter on a skill to show full content; press `q` to return
- [ ] **Agent Registry view** (`agents.ts`): fetches `GET /api/agents` from graph runtime; renders table of registered agents with `name`, `skills`, `status`, `last_heartbeat`
- [ ] `packages/tui/package.json`: `"name": "@graph/tui"`, `"bin": { "graph-tui": "./src/index.ts" }`, `"dependencies": { "@inquirer/prompts": "^7", "js-yaml": "^4" }`
- [ ] `GRAPH_RUNTIME_URL` env var (default `http://localhost:4000`) used for all API calls
- [ ] TypeScript compiles without errors

### Files

- `packages/tui/src/views/graph.ts` — new
- `packages/tui/src/views/patterns.ts` — new
- `packages/tui/src/views/agents.ts` — new
- `packages/tui/src/index.ts` — new
- `packages/tui/package.json` — new
- `packages/tui/tsconfig.json` — new

### Implementation notes

No Vitest tests for TUI — terminal UI requires interactive test setup beyond Phase 6 scope. Verify manually during the checkpoint.

`@inquirer/prompts` v7 requires Node.js 18+. The `select` prompt is the primary interaction primitive. For the live-refresh views (Graph Events), use `setInterval` + `console.clear()` + rerender — no `blessed` dependency needed for this scope.

Parse YAML frontmatter from `SKILL.md` files using `js-yaml` (`load(frontmatterBlock)`). The frontmatter block is the content between the first and second `---` delimiters.

---

## Task 7: Manual verification checkpoint

**Type:** checkpoint:human-verify  
**Effort:** N/A  
**Wave:** 4

### What was built

- T1: `McpClientWorker` — graph runtime consumes external MCP tool servers; calls recorded in graph
- T2: `execute_bash` MCP tool — CommandGate pre-filters; execution writes result to graph
- T3: `packages/gateway-bot` — Telegram long-poll + Discord slash commands; messages spawn tasks
- T4: `UserProfileWorker` — daily synthesis of user profile across scopes
- T5: Agent pairing — cryptographic per-agent trust establishment for multi-user deployments
- T6: SUPERSEDED — graph visualization moved to MemexShell Dashboard (see ROADMAP.md 北极星)

### Verification steps

1. TypeScript compile — all packages (T6 superseded, no tui package):
   ```
   npx tsc --noEmit -p packages/gateway/tsconfig.json
   npx tsc --noEmit -p packages/workers/tsconfig.json
   npx tsc --noEmit -p packages/gateway-bot/tsconfig.json
   ```
   Expected: all exit 0.

2. Unit tests — all:
   ```
   npx vitest run --project packages/shared
   npx vitest run --project packages/workers
   npx vitest run --project packages/gateway
   npx vitest run --project packages/gateway-bot
   ```
   Expected: all pass.

3. CommandGate + execute_bash:
   ```
   EXECUTE_BASH_ENABLED=true node -e "
     // POST to /mcp with execute_bash, command: 'rm -rf /'
     // expect isError: true, BLOCKED hardline
   "
   EXECUTE_BASH_ENABLED=true node -e "
     // POST to /mcp with execute_bash, command: 'echo hello'
     // expect { stdout: 'hello\n', exit_code: 0 }
   "
   ```

4. MCP client tool discovery:
   ```
   MCP_SERVER_URLS=http://localhost:3001 node packages/workers/src/index.ts
   # Start a simple MCP server on 3001 that exposes one tool
   # Verify graph has a memory_updated event with mcp_server and tool fields
   ```

5. Telegram smoke-test:
   ```
   TELEGRAM_BOT_TOKEN=<token> node packages/gateway-bot/src/index.ts
   # Send a message to the bot
   # Verify task_spawned event appears in execution_event_log
   # Verify bot replies with task_id
   ```

6. TUI smoke-test:
   ```
   GRAPH_RUNTIME_URL=http://localhost:4000 node packages/tui/src/index.ts
   # Navigate to Graph Events → verify table renders
   # Navigate to Patterns & Skills → verify SKILL.md files listed
   # Navigate to Agent Registry → verify registered agents shown
   ```

7. Agent pairing smoke-test:
   ```
   REQUIRE_AGENT_PAIRING=true GRAPH_RUNTIME_SECRET=test node packages/gateway/src/index.ts
   # POST /pair/generate { agent_id: "test-agent" } with Authorization: Bearer test
   # Receive { code, expires_in_s }
   # POST /pair { agent_id: "test-agent", code: <code> }
   # Expect { paired: true }
   # Call /mcp with X-Agent-ID: test-agent → expect 200
   # Call /mcp with X-Agent-ID: unknown-agent → expect 401
   ```

### Resume signal

Reply `approved` when all 7 checks pass.

---

## Phase 6 success criteria

- External MCP tool calls appear as `memory_updated` events in the execution graph
- `execute_bash 'rm -rf /'` returns `BLOCKED (hardline)` before any execution
- Telegram bot receives a message, spawns a task, replies with `task_id`
- `UserProfileWorker` synthesizes a profile entity when ≥ 3 Crystals exist for a user
- `/pair/generate` + `/pair` flow pairs an agent; unpaired agent gets 401 on MCP calls
- `graph-tui` renders graph events, patterns, and agents without crashing
- All TypeScript packages compile; all unit tests pass
