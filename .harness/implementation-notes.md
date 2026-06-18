# Implementation Notes — Graph-Native Agent Runtime

Decisions and deviations from the spec that were not covered in planning docs.  
Append only. Resolved items are filed into proper documents — see below.

---

## Phase 1 归档说明（2026-06-03）

Gate 1 测试和 Phase 1 实现产生的所有记录已迁移至正式文档：

| 原内容 | 迁移位置 |
|--------|---------|
| D1 — OCC event_type column 语义修正 | `docs/adr/0042-adr40-task-spawned-first-class-event-type.md` |
| D3 — LLMProvider 迁移到 shared | `.harness/phases/03-execute/.continue-here.json` (remaining_work) |
| D4 — Tool write() SecurityException | `.harness/phases/03-execute/.continue-here.json` (decisions_made, 已解决) |
| D6 — context_oom_throttled status 语义 | `docs/adr/0040-adr38-event-status-execution-vs-convergence.md` |
| G1-Fix-1: OCC 必须直接写入分区表 | `docs/adr/0043-adr41-occ-partition-and-causal-append.md` (ADR 41) |
| G1-Fix-2: Node.js v22 启动方式 | `docs/TECH_STACK.md` §6 |
| G1-Obs-1: Gateway 需要 Bun 运行时 | `docs/TECH_STACK.md` §6 |
| G1-Obs-2: OCC winner 被覆写 bug | `docs/adr/0043-adr41-occ-partition-and-causal-append.md` (ADR 41) |
| Control Plane OOM status=terminated bug | `docs/OPEN_ISSUES_TRACKING.md` §P0-E (Phase 2 必修) |
| 测试文件结构 + E2E 自动化决策 | `tests/README.md` |

---

## Phase 2 活跃备注

### TD-2 根因记录（2026-06-03）

`spawnChildScope` 原来用 `predecessor_hash: ZERO_HASH` 写入父 Scope 分区，
但 `plan_created` 已经占用了 `(ZERO_HASH, scope_id)` OCC 唯一槽位，第二次写入
会静默 demoted（`ON CONFLICT DO NOTHING`）。修复：写入前查询父 Scope tip 版本哈希作 predecessor。
文件：`packages/workers/src/base/subagent.ts`，commit `e88a61b`。

### TD-6 架构决策（2026-06-03）

`ScopeConvergenceTracker` Tier-1 计数器重启后归零属于**有意设计**：
Tier-3 DB SQL 是唯一权威 guard；Tier-1 仅是性能优化（避免 DB round-trip）。
重启后 Tier-1 为 0 → checkAndClose 直通 Tier-3 SQL → 结果与有计数时一致。
不需要持久化 Tier-1 状态。文件：`packages/control-plane/src/watchdog.ts`，commit `1c0674d`。

### D3 迁移状态（2026-06-03）

LLMProvider/EmbeddingProvider 接口已从 `packages/workers/src/llm/` 迁移到
`packages/shared/src/llm/`，并从 `@graph/shared` 统一导出。
`packages/workers/src/llm/` 目录已删除。VERIFICATION.md §D3 已过时。
Commit `44f842c`。

---

## Phase 3 Plan 03-04 决策记录（2026-06-05）

### D-03-04-1: triggerTaskId 不存储在 scope_lineage

ADR 23 §1 中展示的 `scope_lineage` 表有 `trigger_task_id` 列，但 migration 005
的实际 schema 是 `(scope_id, parent_scope_id, depth, intent, status)`，无此列。

决策：`triggerTaskId` 不写入 DB。`createSubScope` 接收后通过 `void triggerTaskId`
明确记录意图（非遗漏）。调用方在子 Scope 关闭时将 `triggerTaskId` 传给 `resolveSubScope`，
后者将其嵌入 `sub_scope_resolved` payload 的 `trigger_task_id` 字段。
Plan 03-06 的 SubScopeResultWorker 从 payload 中读取该值。

### D-03-04-2: SUB_SCOPE_TOPIC 从 pulse-fetch.ts 导出

`graph::scope::sub_scope_resolved` 作为 `SUB_SCOPE_TOPIC` 常量从
`packages/control-plane/src/pulse-fetch.ts` 导出，供 Plan 03-06 直接 import。
避免跨文件 magic string 重复导致不一致。

### D-03-04-3: resolveSubScope 的 ZERO_HASH 防御性回退

当子 Scope 分区没有任何事件时（理论上不可能，但防御性处理），
`childFinalVersionHash` 回退到 `ZERO_HASH`。这与 `nestScope` 的 `plan_created`
事件用 `ZERO_HASH` 作为 predecessor 的语义一致。

---

## Phase 3 — Plan 03-05 Active Notes

### wait_all_tasks timeout behavior (2026-06-05)

Decision: On timeout, `wait_all_tasks` returns `{ timed_out: true, completed: string[], pending: string[] }`.
Implementation: polling loop with 2-second interval, bounded by deadline from `timeout_s`.
LISTEN/NOTIFY aggregation is architecturally correct (D-5 / ADR 09 Pulse-Fetch pattern) but requires
a persistent pg-listen subscription that complicates stateless MCP transport design.
For Phase 3 stateless transport (`sessionIdGenerator: undefined`), polling is the safer choice.

Partial-completion semantics (what to return if some tasks complete before timeout) are deferred to
Phase 4 per CONTEXT.md §Deferred and RESEARCH.md Open Question 3 resolution.

Referenced by: Plan 03-05 Task 2 (wait_all_tasks tool), PLAN.md §"must_haves"

---

## Phase 3 — Plan 03-06 Active Notes

### D-2 AgentCard Bootstrap — Stable UUIDs + Skill Vocabulary (2026-06-05)

Internal Worker AgentCards inserted at boot (packages/workers/src/index.ts):

| Worker | Stable agent_id | Skills |
|---|---|---|
| FrontierSchedulerWorker | a1000000-0000-4000-8000-000000000001 | task-routing, task-dispatch |
| EpisodicMemoryWorker | a1000000-0000-4000-8000-000000000002 | memory-storage, episodic-recall |
| SemanticMemoryWorker | a1000000-0000-4000-8000-000000000003 | memory-storage, semantic-retrieval |
| ProceduralMemoryWorker | a1000000-0000-4000-8000-000000000004 | memory-storage, template-learning |
| ConflictResolverWorker | a1000000-0000-4000-8000-000000000005 | conflict-resolution |
| SubScopeResultWorker | a1000000-0000-4000-8000-000000000006 | scope-resolution, result-synthesis |
| PatternDiscoveryWorker | a1000000-0000-4000-8000-000000000007 | pattern-discovery, cross-domain-clustering |

Skill vocabulary is intentionally coarse — one or two terms per Worker. Fine-grained skills
can be added in Phase 4 once FrontierScheduler routing precision needs are clear (CONTEXT.md §Claude's Discretion).

All inserts use `ON CONFLICT (agent_id) DO NOTHING` so re-boots produce no duplicates (T-03-06-02).
Wrapped in try/catch: boot failure of agent_registry does not crash the Worker process.

---

## Phase 04-plugs — LLM Provider SOLID Refactor (2026-06-09)

### Decisions not covered by spec

**1. `ProceduralMemoryWorker` uses `EmbeddingProvider`, not `LLMProvider`** — discovered during tsc. The 05-PLAN.md "embedding split" note was wrong about `SemanticMemoryWorker` (which uses only `LLMProvider`), but `ProceduralMemoryWorker` does take `EmbeddingProvider`. Fix: added a separate `embeddingProvider` instance in `workers/index.ts` using `OpenAICompatibleProvider` directly (always `openai-completions` — Anthropic has no embeddings endpoint). `llmProvider` from `createLLMProvider()` routes to `AnthropicProvider` when `LLM_API=anthropic-messages`.

**2. `EMBEDDING_MODEL` env var** — `embeddingProvider` reads `process.env['EMBEDDING_MODEL']` (falls back to `LLM_MODEL`). Allows embedding model to differ from chat model when using a dedicated embedding endpoint.

**3. `gateway/index.ts` uses `OpenAICompatibleProvider` directly** — gateway has its own `gatewayLlmProvider`. Added `api: 'openai-completions'` to satisfy `LLMProviderConfig`. If gateway needs Anthropic in future, wire `createLLMProvider()` there.

**4. `ProviderConfig` removed from export surface** — replaced by `LLMProviderConfig`. Only one call site needed updating (`gateway/index.ts`). tsc confirmed no other packages imported `ProviderConfig` by name.

### Local LLM env var reference

| Provider | `LLM_API` | `LLM_BASE_URL` | `LLM_MODEL` |
|---|---|---|---|
| Ollama (default) | `openai-completions` | `http://localhost:11434` | `llama3` |
| vLLM | `openai-completions` | `http://localhost:8000` | `<model>` |
| LM Studio | `openai-completions` | `http://localhost:1234` | `<model>` |
| DeepSeek | `openai-completions` | `https://api.deepseek.com` | `deepseek-chat` |
| Anthropic (Phase 5+) | `anthropic-messages` | _(default: api.anthropic.com)_ | `claude-haiku-4-5-20251001` |

---

### MCP transport import path (2026-06-05)

The RESEARCH.md mentions `@modelcontextprotocol/sdk/server/web.js` as an import path, but this module
does not exist in SDK v1.29.0. The correct path is:
- `@modelcontextprotocol/sdk/server/mcp.js` → McpServer
- `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` → WebStandardStreamableHTTPServerTransport
- `@modelcontextprotocol/sdk/server/streamableHttp.js` → StreamableHTTPServerTransport (Node.js wrapper)

We use `webStandardStreamableHttp.js` directly (Web Standards API, compatible with Hono/Bun).
`enableJsonResponse: true` is set so POST /mcp/messages returns JSON (not SSE stream), which makes
GATE4-4 tests simpler to assert against.

---

## Phase 5 — Provider Safety (2026-06-09)

### AnthropicProvider uses native Messages API, not OpenAI-compat shim

`AnthropicProvider` calls `https://api.anthropic.com/v1/messages` directly (not the OpenAI-compatible
endpoint). This is intentional — Anthropic's native API is more capable (streaming, vision) and avoids
the base-URL workaround needed for the compat shim. Workers use `createLLMProvider()` which routes to
`AnthropicProvider` when `LLM_API=anthropic-messages`.

### CommandGate hardline vs dangerous distinction

`CommandGate.checkCommand()` returns `{ action: 'allow' | 'dangerous' | 'hardline-block' }`.
Phase 6 T2 rejects both `dangerous` and `hardline-block` (no LLM smart approval in Phase 6).
Smart approval (LLM-evaluated) is deferred to a future phase. This is documented in the T2 AC.

### LessonSaveWorker: confidence floor + SHA-256 dedup

`fingerprint_id = SHA256(lesson_text)` prevents re-inserting semantically identical lessons after
scope re-runs. Ebbinghaus formula: `confidence += 0.1 * (1 - confidence)`. Export threshold defaults
to `EXPORT_THRESHOLD = 0.8` env-configurable. The 4 threshold edge-case tests (T3 in Phase 5) cover
below/at/above threshold and exact-boundary behavior.

---

## Phase 6 — Extensions (2026-06-09)

### Discord uses Ed25519, not HMAC-SHA256 (plan text misnomer)

The 06-PLAN.md text says "HMAC-SHA256" signature verification for Discord. This is incorrect — Discord
uses Ed25519. The plan's own AC references `X-Signature-Ed25519` header, which confirms Ed25519.
Implementation uses Node.js `crypto.verify(null, msg, pubKey, sig)` with the raw 32-byte key wrapped
in DER SPKI format (`302a300506032b6570032100` prefix). The test generates a real Ed25519 keypair.

### dispatchMessage generates fresh scope per message (production limitation)

`dispatchMessage(sessionKey, text, pool, sourceMessageId)` generates `randomUUID()` for `scopeId`
per call. In production, a persistent session should use a stable scope UUID per `sessionKey`
(e.g., via `nestScope()`). The current fresh-UUID approach means each message is an independent scope
— acceptable for MVP but means session context doesn't accumulate in the graph. Documented in router.ts.

### pairingGuard checks `REQUIRE_AGENT_PAIRING` per-request, not at construction time

The MCP route middleware reads `process.env['REQUIRE_AGENT_PAIRING']` on every request (not once at
`buildMcpRoute()` construction). This ensures existing tests (which don't set this env var) remain
unaffected, and the env var can be toggled without a process restart in production.

### Pairing store is single-process only (no cross-replica sync)

`packages/gateway/src/auth/pairing.ts` uses an in-memory `Map`. If the gateway is deployed with
multiple replicas, pairing codes and paired-state are not shared across replicas. This is documented
in the pairing.ts header. Distributed pairing (Redis, DB) is a future phase item.

### T6 (graph inspection TUI) superseded by architecture decision

T6 was originally "graph inspection TUI." Superseded: graph visualization belongs in MemexShell
Dashboard (Phase 7+), not a standalone CLI TUI. MemexTerminal is the only TUI entry point and is
a MemexShell component. `packages/tui` was never created. See ROADMAP.md §06-extensions.

## Phase 14 — Trust Isolation (2026-06-11)

### ADR-43 D-2 implementation revision: live-DB blanking, crypto-shredding at the backup seam

For the LIVE database, payload blanking (payload='', erased_at=NOW()) achieves identical
erase semantics to DEK destruction — ADR-43 D-3's verification rules were designed for
exactly this state. Encryption's unique value is BACKUP invalidation, and the KEK
provisioning/rotation questions belong to the Phase 15 backup design. key_registry is
created now (migration 016, destroyed_at marker honored by erase); the encryption
increment lands with the backup key coupling. Recorded as ADR-47 D-1.

### Trust enforcement wired at the MCP route, not the SDK handler

The MCP SDK's tool handlers don't see HTTP headers; enforcement parses POST bodies for
tools/call at the Hono route and reconstructs the Request for the transport. No
X-Agent-ID = local single-tenant caller = trusted when pairing is off (pairing
guarantees the header otherwise); unknown agent ids = untrusted.

### Docker backend delivered as pure arg-builder + bypass rule

buildDockerRunArgs (hermes _BASE_SECURITY_ARGS parity incl. --network none and
--read-only) and approvalRequiredForBackend are pure and fully tested; the actual
docker exec wiring + `docker inspect` containment verification needs a docker-equipped
environment (live E2E item). Hardline blocks in EVERY backend; pattern approval is
bypassed only in docker (host unreachable).

### PII pattern ordering matters

IPv4 redaction must precede the phone pattern — dotted digit runs would otherwise be
consumed as phone numbers. Caught by the red-line test.

### Phase 14 remaining items (carried forward)

1. docker exec wiring + containment verification (docker inspect) — live environment
2. approval-flow channel commands (/approve, /deny parsing in connectors) — the state
   machine + push are done; the inbound command routing is connector glue
3. always-allowlist config write (itself approval-gated) — config.json schema slot
4. ledger-verifier erased_at skip rule — verifier tooling lives with Phase 15 doctor

## Phase 13 — Agent Federation (2026-06-11)

### Multi-candidate ranking is advisory, not assignment

ADR-42 D-1 (no assigned_agent_id) stands. rankCandidates() orders choices where a
choice exists (delegation target, claim-side suggestion); FrontierScheduler remains
availability-gating + SKIP-LOCKED self-claim. Per-agent success history accumulates
from D-4 conflict attribution; until then ranking degrades to trust signal (declared).

### A2A bridge deferred with evidence

The A2A spec could not be verified in this environment (no network guarantee) and the
spec evolves quickly. Interface reservation already exists (self AgentCard declares
protocols ['mcp','a2a'] + endpoints.a2a since Phase 6 side-branch). Landing condition:
verifiable current spec + a real external A2A counterpart. Recorded in ADR-46 D-6.

### principal_alias is a projection table, not graph-only

O(1) alias resolution on every message ingest cannot ride a graph traversal; the table
is the lookup face, the memex::identity::same_as audit event is the graph face. Same
pattern as template_injection (Phase 10).

### Visibility filter is deliberately one function

visibilityFilter() in reflect.function.ts is the single point the post-1.0 federated
mesh will extend (shared = pairing-group scoping). All six retrieval routes (3 tiers ×
2 routes + anti-patterns) bind the principal parameter — red-line test asserts every
memory query carries the guard.

### Delegation cap is opt-in at call sites

spawnChildScope's concurrency guard activates only when countActiveChildren is injected
— existing call sites unaffected until they opt in (surgical-change principle). Default
cap 5 (GRAPH_MAX_CONCURRENT_CHILDREN env).

## Phase 12 — Connector Matrix (2026-06-11)

### Slack implemented without the Slack SDK

Socket Mode is just apps.connections.open (fetch) + a WSS consumer (global WebSocket) +
chat.postMessage. Envelope ack-before-dispatch is the critical protocol detail (Slack
redelivers unacked envelopes). Zero new dependencies; transports injectable for tests.

### Email transport is a seam, not a binding

imapflow/nodemailer (or any IMAP/SMTP lib) binds to the EmailTransport interface at
install time — could not be network-installed in this run, and the connector logic is
fully tested against fakes. Production binding is a Phase 15 install-script step.

### Cron registry writes ride writeInfraEvent with 'archived'

ADR-45's registry-scope auto-close hazard is avoided by never routing registry writes
through the Gateway events path, and 'archived' infra events no longer touch
scope_lineage status (infra-write.ts change). Job identity = payload.name, latest
Snapshot wins; no per-fire writeback (a fired-marker Snapshot per minute would be noise) —
dedup is the run-scope intent existence check.

### Cron delivery is a polling sweep, not a scope_closed subscriber

Connectors live in the gateway-bot process, which is not an iii worker — a durable
subscriber on scope_closed can't call DeliveryRouter from there. The minute loop sweeps
closed cron:* scopes lacking a cron::delivered marker. At most one minute of delivery
latency; acceptable for scheduled jobs.

### Cross-platform continuation = explicit scope reference (Phase 12 level)

resolveScopeTip(scopeId) lets any channel continue a live Trail. Automatic continuation
by unified identity (same_as) is Phase 13 as planned.

## Phase 11 — MemexShell (2026-06-11)

### TD-H resolution differs from the ledger's framing

The "gateway bypasses createLLMProvider()" debt assumed a chat path. Reality: the gateway's
provider was only ever consumed as an EmbeddingProvider (memReflect + memory route) — no chat
exists in the gateway. Resolution: renamed to gatewayEmbeddingProvider, EMBEDDING_MODEL env
aligned with workers. The single-construction-path rule applies to chat providers.

### macro session semantics simplification (TD-E)

Idle-expired sessions roll to a NEW top-level scope under the same `session:<key>` intent
(not a child scope) — nestScope creates top-level scopes; createSubScope is a worker-side
path with depth limits. Session history = all scopes sharing the intent key; Phase 12
cross-platform continuation queries by intent. Parent-linkage refinement is possible later
without migration (scope_lineage.parent_scope_id exists).

### writeInfraEvent promoted to @graph/shared

session-scope.ts needed the scope_closed infra write; occWrite's type surface only allows
agent event types (correct). Promoted the gateway's writeInfraEvent (tip-lookup + pgcrypto
hash INSERT...SELECT + lineage update) to shared — one implementation for gateway watchdog
and gateway-bot session lifecycle.

### 'hono/bun' is Bun-global at import time

createBunWebSocket cannot be imported under Node/vitest. ws-protocol.ts keeps all protocol
logic Bun-free (testable); buildWsRoute dynamic-imports hono/bun and the production entry
mounts /ws only when globalThis.Bun exists. The websocket handler must be the same object
in Bun.serve's export — returned by buildWsRoute.

### Dashboard delivered as live-view v0, not the UI-SPEC console

UI-SPEC locks Next.js 15 + React 19 + @antv/g6 v5 — a frontend project that cannot be
built/visually verified headless in this run. Per 11-PHASE-SPEC §7 the cut falls on
dashboard richness: GET /dashboard ships a self-contained read-only HTML live view (SSE
feed + topology lookup) proving the realtime data path. The full console remains open.

### MemexTerminal v1 = WS protocol client + readline REPL

Pi-SDK interactive agent mode (createAgentSession driving a local coding agent) is the
recorded next increment — it requires a live gateway + provider keys to verify. The
protocol client (tip-hash chaining, request correlation, trail fan-out) is fully tested.

### Phase 11 remaining items (carried forward)

1. Pi-SDK interactive mode for MemexTerminal (needs live verification environment)
2. Full UI-SPEC console (Next.js + G6) — frontend project
3. DoD G1/G2/G3 live E2E (session continuity, WS turn, SSE dashboard) — skipIf-style
   integration tests pending a running Postgres + gateway
4. memex connect remote-address extension is Phase 15 scope (TLS + token), not Phase 11

## Phase 10 — Trail Discovery (2026-06-11)

### Metrics as columns + join table, NOT ledger events (PHASE-SPEC deviation)

10-PHASE-SPEC said "指标存图（事件）". Implemented instead as `procedural_memory.injection_count`
+ `template_injection` join table (migration 013). Reason: OCC slot uniqueness is
`(predecessor_hash, scope_id)` (ADR 41) — writing a metric event mid-scope after the agent's
event would claim the agent's predecessor slot and demote the agent's NEXT write to
conflict_detected, polluting the Trail with false conflicts. Metrics remain SQL-queryable
(hit-rate recipe in ADR-52). Recorded in ADR-50 D-4.

### Three-signal rerank, not four (ghost column)

ADR-20 supplement's 4-signal SQL references `unique_worker_types` — a column that was never
created. Followed the original P0-B decision (3 signals: rrf 0.6 / quality 0.3 / recency 0.1)
per the "remove dangling design references" principle. Added pool-max RRF normalization —
raw RRF (~0.01 scale) would be drowned by quality/recency (0..1 scale). ADR-50 D-5.

### macro_planning trigger = task_spawned, not plan_created

EventBodySchema (Zod gate, ADR 24) restricts agent-route events to task_spawned|memory_updated.
plan_created is written at scope creation — which is cold_start by definition. In this protocol,
spawning sub-tasks IS the in-scope planning act, so macro_planning fires on task_spawned.

### P2-D optional event trigger skipped (YAGNI)

"≥20 episodic rows → immediate synthesis" event trigger not implemented; the 02:00 cron
covers it. Documented in ADR-52 §2 with the re-enable condition.

### Anti-pattern retrieval is BM25-only

Anti-pattern rows have no intent_embedding (TPW writes them embedding-less on the intent
axis); the negative HNSW index is on topology_embedding, which has no query-side vector at
reflect time (the new scope has no topology yet). ts_doc BM25 is the relevance signal.

### TPW intent-embedding reuse

The episodic intent+outcome embed call doubles as the positive template's intent_embedding
(one embed call, two writes — token efficiency). Semantic basis is intent+outcome rather than
intent-only; accepted, outcome enriches retrieval relevance.

### Phase 3 infrastructure absorbed more of Phase 10 than ROADMAP assumed

Already existed before Phase 10 started: WL kernel, PatternDiscoveryWorker + cross-domain
union-find clustering (6h cron), synthesizer/decay/TTL crons, CrystallizeWorker surgical
distillation, LessonSave Ebbinghaus confidence, working-memory dedup helper. Phase 10's
actual new surface: template_graph canonical schema, TPW positive/correlation paths,
3-signal rerank + anti-pattern injection, trigger selection wiring, reinforcement closure,
contradiction supersession, TD-B production wiring, injection metrics.

---

### TS2440 Pool name conflict in gateway-bot entrypoint

`packages/gateway-bot/src/index.ts` uses `import type { Pool } from 'pg'` (type import) for the
class field type annotation, but the entrypoint also does `await import('pg')` (dynamic ESM import).
TypeScript raised TS2440 (duplicate identifier) when destructuring `const { Pool }`. Fixed by renaming
the dynamic import binding: `const { Pool: PgPool } = await import('pg')`. Commit 589d3ef.

---

## Phase 15 (deploy-everywhere) — deviations & decisions

### TD-M resolved by convergence, with one docs trap

Gateway now runs on Node 22 (`node --import tsx/esm`); Bun kept as a compatibility branch.
Trap recorded in ADR-48 D-1: hono.dev currently documents `upgradeWebSocket` exported from
'@hono/node-server' — that export does NOT exist in the released 1.19.x. The stable path is
`@hono/node-ws` createNodeWebSocket({app}) + injectWebSocket(server), which requires
registering /ws on the SAME Hono instance that serve() runs (a sub-app mounted via
app.route() does not receive the upgrade).

### iii engine in Docker: jq hard dep + version skew

install.iii.dev/iii/main/install.sh fails without jq (found in image build, not documented).
Image gets iii 0.19.2 while dev machine has 0.11.2 — full-stack compose smoke showed
`Trigger registration failed ... (scheduled): Trigger type "scheduled" not found` under
0.19.2. Core function unaffected (workers registered, OCC writes flow); scheduled crons
inside the container would not fire until the trigger provider question is resolved
(pin engine version or `iii worker add` the cron provider). Carried forward.
Also observed: the iii container logs a persistent internal `failed to connect; retrying`
loop (os error 111) that does not affect worker registration — not diagnosed.

### Full-stack compose smoke PASSED (the long-standing live-E2E gap, partially closed)

deploy/docker-compose.yml up → all 6 services healthy → POST /v1/scopes (3-phase DDL
nesting) → POST events (OCC won, pgcrypto hash, Knapsack context) all through containers.
Backup/restore cycle also live-verified (pg_dump -Fc in pgvector container → restore to
fresh DB → doctor hash-chain intact). Node-runtime gateway live-verified (REST + WS).

### Deliberately not implemented (ADR-48)

Backup encryption (D-4: retention = erase delay, printed by `memex backup`); automatic TLS
(reverse proxy's job); egress proxy allowlist (documented extension point); multi-replica HA.

### Carried forward (live-environment items)

Three-platform install script runs (only syntax-gated + logic-reviewed here); compose up
on macOS/Linux hosts; iii version pinning decision; service-file registration on real
systemd/launchd hosts.

---

## Phase 16 (memexos-one) — deviations & decisions

### Lesson metrics home corrected by live run

eval-metrics first targeted semantic_memory for retention; the live journey run failed with
"column reinforcement_count does not exist" — Ebbinghaus columns (reinforcement_count,
confidence) live in procedural_memory (migrations 006/011). Fixed; recorded in ADR-49 D-1.
Lesson: run metric SQL against a migrated DB before trusting column placement from memory.

### Journey ran live, twice

7/7 steps green against Node-runtime gateway + migrated Postgres: scope create, OCC won,
conflict demoted, projection sampling, memory search, erase (blank + chain intact),
snapshot baseline; second run exercised the regression comparison path green.
Steps that need LLM keys (crystallization/reflect content assertions) are not in the
journey yet — carried forward with the live-E2E items.

### Registry API shapes unverified (by design)

agentskills.io / ClawHub descriptor objects follow public docs; first live call corrects
them (16-PHASE-SPEC risk note). Injectable-fetch unit tests pin the client behavior either way.

### Telemetry: zero implementation (ADR-49 D-3)

Deliberate. All usage data is already in the graph; eval metrics consume the ledger directly.

### Carried forward (live-environment items, full list for the goal report)

- Phase 11: Pi-SDK interactive terminal mode; full UI-SPEC console (Next.js+G6)
- Phase 12: Email transport production binding (imapflow/nodemailer); cross-platform journey
- Phase 13: A2A minimal bridge (needs verifiable spec + counterpart)
- Phase 14: docker exec live wiring + containment verification (docker inspect);
  /approve //deny connector command routing; always-allowlist config write
- Phase 15: three-platform install runs; compose up on macOS/Linux; iii version pinning
  (0.19.2 image vs 0.11.2 dev — scheduled trigger provider gap); service registration on real hosts
- Phase 16: real registry API verification; LLM-keyed journey extension (distill/reflect steps)

## Phase 17 — mcp-connector-ecosystem (2026-06-12)

### Decisions not covered by the spec

- **MemexOAuthProvider lives in @graph/shared**, not packages/cli as ROADMAP sketched:
  both CLI (login flow) and workers (transport authProvider) consume it, and neither may
  import the other. SDK types are imported type-only — zero runtime dependency added to shared.
- **Capability scope creation stays a CLI/control-plane right** (ADR-35): `memex mcp`
  ensures the `capability:registry` scope via nestScope; McpClientWorker only SELECTs it
  and skips observation recording when absent (resumes once the scope exists). Workers
  never run scope DDL.
- **Tool Entity ids are content-derived** (sha256('mcp-tool|ns|tool') → UUID shape), no
  new table: surface_changed events carry {name, entity_id} pairs; call events add
  tool_entity_id to payload. Per-tool stats are a projection over the ledger (ADR-51 D-3).
- **CLI graph writes are best-effort**: DB unreachable → warn + proceed (config write is
  the user-facing contract; observation backfills on next surface_changed). Deviation
  from a strict reading of ADR-51 D-7 "install writes Entity" — recorded as acceptable
  because the alternative (install fails when DB down) breaks the offline onboarding path.
- **requires_env values never persist**: install prompts set session env only and print
  shell-profile guidance; config keeps `${VAR}` references (raw-file editing, no
  resolution on write).
- **configure's tool multiselect requires a live connection**; offline → env updates
  still save, tool selection skipped with a notice.

### Changed from the original plan

- ROADMAP said oauth-provider.ts in packages/cli/src/mcp/ — moved to shared (above).
- connect/claude-code.ts mirror: Memex entries never overwrite same-named existing
  Claude Code entries (user's file wins) — spec didn't state precedence.

### Verification

- tsc clean; 33 new tests across worker (11) / catalog-registry (13) / oauth-provider (7)
  / mcp config editing (5+); existing 3 worker tests preserved (hermetic via injected config).
- Live OAuth flow + real catalog server connect not exercised (needs network + live remote
  MCP) — carried to Phase 18 live-environment batch.

## Phase 18 — first-run-experience (2026-06-12)

### Decisions not covered by the spec

- **Capability stats follow the migration-013 pattern**, not ledger payload parsing:
  payload is TEXT (migration 002 red line), so co-occurrence lives in
  capability_activation (scope_id, implementation) + capability_binding read model
  (migration 017). Binding history stays in the ledger (memex::capability::bound);
  the table is the current-state projection.
- **Onboarding presets vs "onboarding writes no graph"** (Phase 11 principle):
  preset selection installs ARTIFACTS only (bundled-skill copies, install hints for
  other forms); bindings happen via `memex capability bind` once the DB is up.
  ADR-51 binding semantics and the Phase 11 boot-order reality are both honored.
- **Dashboard auto-open is health-gated**: onboarding only opens the browser when
  /v1/sys/health answers (fresh installs have no services yet — opening a 404 helps
  nobody). Deviation from a literal reading of ROADMAP "自动打开 Dashboard".
- **Terminal auto-start → printed hint** (npx memex-terminal): spawning a TUI from
  inside the clack onboarding session breaks both UIs.
- **Agent-mode ledger discipline**: Pi session deltas render only; the graph gets
  turn boundaries (assistant message_end ≤2000 chars, tool_execution_end ≤500 chars).
- **Preset table is TS, not YAML dir**: curated in-repo either way; YAML parse surface
  adds nothing until external contribution exists. Categories: browser/search/
  filesystem/github/meta (v1 vocabulary, ADR-51 Category Entities).
- **iii version pinning NOT done**: install.iii.dev's version-selection interface is
  unverified offline — guessing a VERSION env contract would be fabrication. Stays in
  the live-environment batch.

### Changed from the original plan

- buildSessionKey platform union widened to email/slack/webhook (email production
  binding needed it; slack/webhook were already valid platforms in Phase 12 routing).
- `memex connect telegram` validates via direct getMe (zero-SDK, Phase 12 ethos)
  instead of reusing gateway-bot's ConnectorRegistry — avoids cli→gateway-bot dep.

### Verification

- tsc clean; 534 tests (was 509): wsl detection/browser-cmd/doctor-check,
  capability graph fns (mock pool), endorsement rendering, telegram validate/write,
  imap url parse, agent-mode truncation; onboarding tests extended for the new prompts.
- LIVE leftovers (unchanged ownership): real WSL2 Kali install run, macOS/Linux install
  runs, docker exec containment verify, live Telegram pairing handshake, Pi agent mode
  against a live gateway, email against a real IMAP/SMTP pair, iii version pinning.

## Phase 19 — console-and-artifacts (2026-06-12)

### Decisions not covered by (or revising) the spec

- **Artifact events → read model + payload references** (ADR-52 D-1), revising the
  ROADMAP's `memex::artifact::created` Association sketch: payload is TEXT (migration
  002) and mid-scope infra events claim OCC slots (migration 013) — so artifact metadata
  is the `artifact` table (migration 018), content is hash-addressed on disk, and the
  ledger references artifacts through producer result payloads. Zero ledger bloat.
- **PK (content_hash, scope_id)**: shared content across scopes = N provenance rows,
  one file; erase unlinks the file only when no live row references the hash.
- **Producer opt-in** (ADR-52 D-3): saveArtifact() is mechanism; first mandatory
  producer is the Phase 20 browser screenshot path.
- **Skill scope = ADR-46 tri-level reuse** (ADR-52 D-4): global/profile implemented
  (--scope flag, profile default = zero migration); principal level lands with
  Phase 20 agent-initiated installs.
- **Console**: full Next.js 15 + React 19 + G6 v5 + Recharts + Tailwind package
  (packages/console) per UI-SPEC; root tsc excludes it (own tsconfig; `next build`
  is the compile gate — all 9 routes prerender). Missing UI-SPEC backend contracts
  landed: /v1/metrics/infra, /v1/scopes/audit/suspended. Web Worker force layout
  deferred until canvas jank is observed live (value change, not type change).
  suspended audit's error_reason maps from scope intent in v1 (no dedicated
  error_reason column exists; revisit if a real column lands).

### Verification

- tsc clean; 543 tests (was 534): artifact store (hash addressing, traversal guard,
  idempotent write, erase cascade with shared-hash protection), topology-diff.
- next build: 9/9 routes compile + prerender; G6 dynamically imported (not in
  first-load JS). LIVE leftover: visual verification of the G6 canvas against a
  running gateway (joins the live-environment batch).

## Phase 20 — autonomous-assistant (2026-06-12)

### Decisions not covered by the spec

- **skills client + guard moved to @graph/shared** (ADR-53 D-7): gateway needs
  scanning + registry install for agent-initiated acquisition; cli keeps consuming
  via @graph/shared. Pure-logic move, zero new deps in shared.
- **capability_install v1 scope**: skill:<registry>:<id> refs execute end-to-end;
  preset:<name> refs return operator guidance (presets may need interactive env/
  OAuth that only the CLI can drive). Recorded in ADR-53 D-1.
- **Two-phase tool call instead of a blocking tool**: capability_install returns
  approval_id immediately (MCP transports time out; approvals take minutes-to-
  never). Same shape for ask_user (poll ask_user_status).
- **executeInstall TOCTOU stance**: installSkill re-downloads + re-scans; the
  `confirmedDespiteFindings=true` flag is legitimate there because the human
  approved WITH the scan report in the approval body.
- **Vault KEK is operator-owned env** (MEMEX_VAULT_KEK): no key derivation, no
  silent fallback — missing KEK = vault loudly unavailable. Journey step 5c is
  KEK-gated for the same reason.
- **Browser network=bridge deviation** from exec-backend's default 'none' is the
  single security-arg change (a browser without egress is a paperweight);
  everything else from _BASE_SECURITY_ARGS stays.
- **Ledger redaction**: browser op events record {op, implementation, artifact_hash?}
  — never url/selector/fill values (fill may carry injected secrets).

### Verification

- tsc clean; 561 tests (was 543): vault lifecycle (roundtrip/shred/fail-closed/
  redact-inject), ask-user state machine, acquisition (approval gating, guard
  report embedding, down-registry tolerance), browser mapper (5 ops, quoting,
  security args). Journey steps 5a-5d added (live-gated, typechecked).
- LIVE leftovers added: memex-browser container image build + real docker browser
  run; /approve //answer chat-command routing (joins Phase 14's batch); journey
  5a-5d live run.

## Quality pass (2026-06-12, post Phase 17-20)

- Deduplicated: cli withPool (mcp.ts + capability.ts → db.ts), browser-open logic
  (mcp.ts now delegates to wsl.openUrl — WSL-aware everywhere).
- Security gap closed: MEMEX_VAULT_KEK + MEMEX_GATEWAY_TOKEN added to execute_bash
  SCRUB_KEYS (the scrub list is default-allow; the KEK passing into subprocesses
  would have let host code unwrap every vault credential). env-filter (default-deny)
  was already safe.
- SHA-256SUMS regenerated (install.sh changed in Phase 18).
- Debt sweep: zero in-code TODOs; docs/archive/OPEN_ISSUES_TRACKING.md items all
  absorbed by phases 9-16 (G1 traversal algebra stays the documented post-1.0
  candidate, no blocking evidence).
- Gates: tsc clean, 561 tests green, next build 9/9, checksums verified.

## ADR-56 实现（2026-06-12，开箱体验修复弧 1/5）

- 新增 `shared/src/llm/provider-profiles.ts`（12 个 profile 含 custom）+ `from-config.ts`
  （buildChatProvider / buildEmbeddingProvider / resolveEmbeddingEndpoint）+ `config/dotenv.ts`
- spec 之外的决定：
  - `resolveProfile` 对未知 name 回退 custom profile，老 config 不会 boot 失败
  - embedding 推导**绝不**把 chat model 当 embedding model（vllm 无默认 embedding model 时返回 null 而非编造）
  - `supportsEmbedding` 标志按保守原则只给有把握的端点（openai/ollama/gemini/vllm/lmstudio/custom）
  - workers 的 embedding 构造暂未切到 nullable builder——等 ADR-55 的 null 处理一起落（避免中间态破窗）
  - doctor 新增 embedding 检查（warn 语义）提前落在本批（探测派生本来就是 ADR-56 的派生纪律）
- gateway/terminal/doctor/onboard 端口统一 DEFAULT_GATEWAY_PORT=4000
- dev.mjs onboarding gate：config.json 缺失时 stdio-inherit 跑 onboard，失败不阻塞 env-only boot

## ADR-55 实现（2026-06-12，开箱体验修复弧 2/5）

- 故障分类切口：processAgentTurn 的 catch 用 classifyProviderError——只有 context_length
  reason 触发 lockout，其余记 context.degraded（warn）后 context:null 返回，scope 存活
- classify-error 补 'fetch failed' 模式（undici 通用网络失败文案，原本落 unknown）
- memReflect：embed 参数 nullable + embed 失败内部吸收；降级 = 三层全走 BM25-only SQL
  （RRF 退化为 0.4 分量，procedural 三信号 rerank 结构保留）；输出新增 degraded 标志
- 迟到投影：migration 020 embedding_backlog（UNIQUE(table,id,column) 幂等）；
  semantic/template-proposal/procedural 三个 worker embed 失败时写 NULL embedding + 入队；
  **删掉了 template-proposal 的零向量 fallback（零向量污染余弦相似度，比 NULL 更糟）**
- EmbeddingBackfillWorker：5min cron 排水，目标表列走代码侧 allowlist（绝不拼接行值进 SQL），
  首个失败即 abort（端点还没恢复就别空转）
- spec 之外的决定：semantic NULL 写入跳过 merge/contradiction 检查（需要向量），回填只恢复
  索引参与度、不做追溯去重——记入 ADR 后果节的隐含义
- N8：migration 021 全量解锁 suspended（安全论证：真溢出下一次写入按新分类法自动重锁）

## ADR-54 实现（2026-06-12，开箱体验修复弧 3/5）

- 对话核心：packages/gateway/src/conversation/core.ts（runConversationTurn）——无状态，
  每 turn tip 查询→processAgentTurn 投影→LLM→助手回合 occWrite 回图
- spec 待定项落定：
  - 事件类型不开 memex::turn::* 新枚举（ADR-40 哈希一等列扩枚举成本>收益）——
    memory_updated + payload kind conversation.user/assistant + 唯一 turn_id（防 TD-B 去重误杀）
  - 工具结果以纯文本折回对话（单工具循环不需要 provider 级 tool-message 协议），上限 3 轮
  - text_delta v1 = 单块退化流（providers 无 token streaming；协议槽位已激活，
    后续只改 provider 不改协议）
  - chat provider 为 null（完全未配置）时返回 onboard 指引而非拨打不存在的 localhost
- Provider 层新增 ToolCallingProvider.chatTurn（openai tools / anthropic tool_use 两条传输），
  FallbackProvider 同语义穿透；**顺带修了 AnthropicProvider 的潜在 400 bug**：
  role:'system' 原样塞 messages 数组（Messages API 拒收），现拆到顶层 system 参数
- 入口：WS user_message（terminal 流式）+ POST /v1/scopes/:id/chat（gateway-bot 渠道）；
  渠道 onMessage 返回值从 "Task spawned: ..." 变成真实助手回复
- processAgentTurn 增 ccrStore 穿透参数（memex_retrieve 当 turn 取回被裁剪事件）
- run-migrations.ts 加 pg_advisory_lock：并行 vitest worker 同时跑迁移的死锁（被 021
  的全表 UPDATE 放大暴露）系统性修复

## 杂项修复 N2/N3/N4/P3（2026-06-12，开箱体验修复弧 4/5）

- N2：user-profile trigger scheduled→cron（引擎 7 字段表达式 0 30 3 * * * *）；
  mcp-client 干脆去掉 trigger 注册（@startup 非法 + boot 已直连，注册纯属误导）
- N3：pulse-fetch 两条路径（replay+实时）从 trigger(topic名) 改为 trigger(SUB_SCOPE_RESULT_FUNCTION_ID)
  + 解析行 payload 全量传递——**审计发现原代码 payload 形状也错了**（{scope_id,event_id} vs
  worker 期望的 child_scope_id 四元组），即使函数名对了也跑不通；函数名常量收进 shared 防再漂移
- N4 根因：occWrite 的 pg_notify payload 是 JSON {"id":N}，ws-protocol 广播器拿原始字符串
  当 bigint id 查询→必抛→静默吞。stream.ts（SSE）同病但症状轻（失去 enrichment）。
  修复：parseGraphEventReadyPayload 放在 occ-write.ts（与发送方同模块），两个消费点接入
- P3：agent-mode .catch 改记 stderr；**顺带修语义冲突**：ADR-54 后 sendUserMessage 会触发
  对话核心，agent-mode（Pi 是应答者）改用 recordEvent 纯镜像，避免双应答者

## 质量收口批次（2026-06-12，开箱体验修复弧 5/5）

- 活体冒烟（smoketest profile，测后清理）：scope 不锁死✓ trail 广播 3 条✓ 历史误锁清零✓
  REST/WS 双入口清晰报错✓ —— FINDINGS 五步路线全部活体验证
- 安全：/v1/scopes/:id/chat 挂 tokenAuth（从 realtimeAuth 拆出纯 token 校验，不吃 10/min
  连接桶——聊天是 per-message 端点）；gateway-bot 调 /chat 带 Bearer token
- cron 的 message-handler spawn 保留——那是真异步任务（外部 agent 认领），符合 ADR-54 D-4 边界
- 测试基建两项结构修复：
  - GATE4 双文件共用 'typescript' 技能 → 并行运行互偷任务（FOR UPDATE SKIP LOCKED），改唯一技能
  - OCC 写入加 40P01 死锁牺牲者有界重试（2 次 + 抖动）——分区 DDL 与分区 INSERT 锁序倒置
    是生产路径同样存在的窗口，重试是教科书响应；migration 021 改 SKIP LOCKED 防等锁
- 全仓零 TODO/FIXME 标记；连续 4 次全量 638/638 绿

## Claude 自主调试原语批次（2026-06-12 晚）

- --agent 模式退役（agent-mode.ts + 测试删除，terminal 不再依赖 Pi SDK）：对话只有一个应答者
  （ADR-54 gateway 核心）；Pi 的正道 = memex connect pi（外部 coding agent，自配置认领异步任务）。
  --agent 现在打印迁移指引退出。三层命名拍板里"MemexTerminal=Pi SDK 实现细节"的旧定位正式作废
- memex chat -m "text" [--scope <id>]：非交互单发，回复走 stdout、scope id 走 stderr（管道干净）；
  --scope 续聊。活体验证：单发 SINGLE-SHOT-OK + 跨 turn 暗号记忆（图投影记忆的活体证明）
- dev.mjs 日志落盘 ~/.memex/logs/dev.log（ANSI 剥离、append、每次 boot 带时间戳头）——检修口
- onboarding gate 非 TTY 跳过（打印 memex onboard 指引，env-only boot）——背景启动不再卡死
- bin launcher（上一提交）+ 本批 = Claude Code 多终端调试原语齐备：
  background `npm run dev` / `memex chat -m` / doctor / REST/WS / psql / dev.log

## ui-console session (2026-06-13) — embedded chat + first-run handoff

- **Console ds redesign committed** (6c376cfa): the uncommitted working-tree
  redesign (ds/ design system, Shell chrome, token files, 5 pages migrated) was
  verified rendering via agent-browser and committed. Fixed a build-breaking
  `@import` order in globals.css (CSS @import must precede @tailwind base).
- **Embedded chat page** (b41c95e3): /chat = assistant-ui LocalRuntime over the
  ADR-54 conversation core. Decision: chat is embedded in the Dashboard (user's
  literal Option C from the paused fuller session), NOT a duplicate of
  MemexTerminal — they share ONE responder (gateway conversation core). The
  console adds a server-side SSE bridge (/api/chat) that holds gateway.token
  server-side and re-emits text_delta; the browser never sees the token. New
  GET /v1/scopes/:id/messages projects conversation.user/assistant events for
  session resume.
- **Embedding dim padding** (b41c95e3): schema is vector(1536) but BGE-M3 emits
  1024 / Gemini 768. Padded zero-fill to 1536 at the provider boundary
  (openai-compatible.provider.ts) — inserts failed silently otherwise. Cosine
  ordering preserved among same-model vectors. Existing 50 rows were 1536 (prior
  Gemini/OpenAI), so no migration needed.
- **Next 15→16**: assistant-ui 0.14 imports React 19.2 `useEffectEvent`; Next
  15.5 bundles React 19.1 → runtime TypeError. Bumped console to next@16.
- **First-run handoff (dev.mjs)**: after the stack is healthy, an interactive
  TTY boot clears the firehose and drops into MemexTerminal (the conversation),
  matching the goal "onboarding 完成后出现 MemexTerminal 对话而不是 iii log".
  Component logs keep flowing to the ~/.memex/logs/dev.log sink. Gated on
  `process.stdin.isTTY` + absence of `--logs` / `MEMEX_DEV_LOGS=1` — agent/CI
  (non-TTY) boots keep streaming, which is what they need. SIGINT handler is
  retained through handoff (Windows children aren't job-linked; shutdown() is
  idempotent and reaps services on Ctrl+C).
- **`memex log`** (new CLI command): tails ~/.memex/logs/dev.log (-n N,
  --no-follow). This is the explicit, opt-in surface for the raw iii/component
  logs — the conversation is the default surface, the log firehose is behind a
  command, per the goal.
- Live-verified against local llama.cpp Qwen3-35B (chat 8080) + BGE-M3
  (embeddings 8082): /chat send→trail-write→reply→resume, MemexTerminal -m,
  handoff health-gate + terminal spawn, memex log tail.

---

## Channel-connectivity deep-dive — hermes DRY + UX (2026-06-13, /goal)

Research/design deliverable (no code shipped this session — gated on decisions below):
`docs/guides/channel-connectivity-hermes-deep-dive.md`.

- **Core finding**: hermes's 20 adapters collapse to **3 transport families** —
  (A) outbound-initiated (long-poll / persistent WS / SSE, no public URL, GFW-friendly),
  (B) inbound webhook (needs public URL + ONE shared HTTP host), (C) local-daemon bridge
  (signal-cli, BlueBubbles macOS server). Family decides connect mechanism + pairing UX,
  not the brand.
- **Shared transport seam (DRY)**: hermes centralizes `resolve_proxy_url` (✅ we ported →
  `channel-http.ts:resolveProxyUrl`), `proxy_kwargs_for_bot` SOCKS+rdns (❌ GAP — no socks
  dep; real for CN/Clash users), `TelegramFallbackTransport` IP-fallback (✅ ported →
  `telegramFetch`), `platform_httpx_limits` keepalive (❌ not ported, low pri).
- **Two patterns our connectors lack**: self-healing reconnect (exp backoff + jitter —
  hermes ADDING_A_PLATFORM mandate; Slack `_restart_socket_mode`, Telegram pool-reset),
  and a shared inbound webhook host (`webhook.py`/`api_server.py` → one Hono app,
  `POST /webhooks/:platform` + per-connector verifier).
- **UX honesty thesis**: last session's bug = valid token + unreachable network surfaced
  as "pairing failed". Settings `Channels` panel today shows only config-presence
  (`configured` bool from `sys/config`), never runs `check()`, never renders `check.detail`.
  Spec'd a 4-state pill (Connected/Configured-not-connected/Needs-setup/Error) shared by
  `memex doctor` + Dashboard, verbatim `check.detail`, per-family ChannelCard, and a
  "Test connection" button that exposes the transport path used (proxy / IP-fallback /
  sticky IP). Deferred building the live-check endpoint — it needs gateway wiring +
  the §7 decisions, not a drive-by.
- **Open decisions (need human)**: (1) add socks dep? (2) build shared webhook host now
  or on-demand? (3) next channel = Slack Socket Mode (recommended)? (4) ship a signal-cli
  sidecar? See deliverable §7.

---

## docker containment 活体验证 + execute_bash 接线发现 (2026-06-13, /goal fuller)

**结论级发现(代码 research):`execute_bash` 的 docker 容器化从未接线。**
`server.ts:491-498` 的 execute_bash 无条件走宿主 `child_process.exec`(CommandGate +
scrubEnv),**没有 backend 选择逻辑**。`buildDockerRunArgs`/`ExecBackendKind`/
`approvalRequiredForBackend` 的唯一真实消费者是 `browser` 工具(server.ts:729 真
`execFile('docker', args)`)。即 ADR-47 D-4 / Phase 14「红线全绿」里
"in-container commands ... cannot reach the host" 对 execute_bash **是假的** ——
execute_bash 每条命令都到达宿主。Phase 14 绿灯靠的是 `approvalRequiredForBackend`
的单测,而 execute_bash 永不调用它(CLAUDE.md §5 点名的 **Proxy Signal**)。
> 边界澄清:execute_bash 非裸奔 —— 宿主路径有 CommandGate(硬拦+危险审批)+
> scrubEnv 两道真实防御。缺的是容器化隔离那道。docker 容器化真实存在且接线,
> 但只给了 browser,没给 execute_bash。设计意图本是 execute_bash→docker(network
> none;doctor.ts:252 "prefer the docker backend";exec-backend default network='none'),
> 接线遗失。

**browser docker 容器化:8/8 活体验证通过(docker 29.4.3,本机,alpine:3 探针)。**
用 browser 路径的确切参数向量跑逃逸套件(参数与镜像无关,故用 alpine 替镜像、
探针替 agent-browser):
- P1 根只读✓(/etc /root 写失败)  P2 /tmp 可写✓  **P3 /tmp noexec✓(唯一可写目录无法执行代码)**
- P4 cap-drop ALL✓(`CapEff=0000000000000000`、chown denied)  P5 `NoNewPrivs:1`✓
- P6 宿主隔离✓(无 /host、hostname=容器id)  P7 inspect✓(ReadonlyRootfs/CapDrop[ALL]/
  no-new-privileges/PidsLimit256/Memory1g/NanoCpus1/**Binds=<no value>**/Tmpfs noexec 全落实)
- P8 egress:browser=bridge **能**外联(可外泄,设计取舍;execute_bash=none)

**残留(硬化缺口,非逃逸):** 容器内 `uid=0(root)`,被 cap-drop ALL 阉割(CapEff=0)
故为零权限 root;加 `--user` 可更稳。

**关账影响:** Phase 14/20 carried "docker exec containment verification (docker inspect)"
—— **browser 路径已 live-done**。execute_bash 路径不是"待验"而是"未接线",转为待决策
(A 改声明 / B 接线 docker backend),已有活体证据(地板是实的)。

### B 决定落地:execute_bash 接线 docker backend + network=none 活体验证 (2026-06-13)

承上「execute_bash 容器化未接线」发现,用户拍 B(接线代码对齐声明)。实现(外科手术式):
- `exec-backend.ts` 新增 `resolveExecBackend()`(EXEC_BACKEND!=docker→'local' 不探测;
  =docker 且 docker 可达→'docker';=docker 但不可达→**null=fail-closed**)+ `isDockerAvailable()`
  (缓存 `docker version` 探测)+ `_resetDockerAvailability()` 测试缝。
- `server.ts` execute_bash 重写:resolveExecBackend→fail-closed 拒绝(绝不静默回退宿主,
  因 docker 后端绕过 dangerous 审批)→`approvalRequiredForBackend` 决策→docker 走
  `execFile('docker', buildDockerRunArgs(cmd,{network:'none'}))`、local 走原 `exec`。
  payload 记 backend;docker 内 dangerous 放行记 `approval_bypassed:true`。
  类型收窄:`if (!verdict.allowed && (gate.blocked||gate.requiresApproval))`(GateVerdict 判别联合)。
- **默认 backend=local,行为逐字不变**(EXEC_BACKEND 未设→不探 docker)——3 个原 execute_bash 测试 + 全 gateway 189 测试不破。

**活体验证(走真实代码路径,非手敲参数;docker 29.4.3 本机):**
`EXEC_BACKEND=docker` → `resolveExecBackend()`=docker✓;真 `buildDockerRunArgs` 的 `--network`=none✓;
L1 容器内命令照跑✓;**L2 egress 被断**(`wget: bad address` DNS 失败 —— 注:验证脚本正则把错误信息里的
"telegram" 误判成"reached net",实为 PASS);**L3 网络接口数=1(仅 loopback)= network=none 硬证据**
(对比 browser bridge 有 eth0、P8 打通了 telegram)。fail-closed 是纯逻辑,单测覆盖未活体。

**Gate:** tsc clean;security.test 18(+1 `resolveExecBackend` 默认 local 不变量);gateway 189 全绿。
**残留:** execute_bash 默认仍 local —— 生产要容器隔离需显式 `EXEC_BACKEND=docker`(doctor 已提示 prefer docker);
镜像默认 alpine:3(`EXECUTE_BASH_IMAGE` 可覆盖,但 alpine 缺工具的命令会失败——容器化取舍);
容器内 uid=0 被 cap-drop 阉割,加 `--user` 可更稳(browser 同此硬化缺口)。ADR-47/Phase-14 措辞现已与代码一致(声明为真)。

### --user 非 root 硬化 (2026-06-13)

承「容器内 uid=0」残留,补 `--user` 到 `buildDockerRunArgs`(execute_bash + browser 共用)。
- `DEFAULT_CONTAINER_USER='65534:65534'`(nobody,alpine 及多数镜像都有),`opts.user` 可覆盖。
- hermes(docker.py)的姿态不同:它**默认不加 --user**,而是 cap-add SETUID/SETGID 让镜像 init
  经 s6-setuidgid 自降权——为它的 init 镜像设计。我们镜像无 init(`sh -lc` in alpine),
  **直接以非 root 启动**是更简单的等效硬化。将来真 browser 镜像若需固定 profile 用户,经 opts.user 覆盖。
- **活体验证**:`id: uid=65534(nobody)`(不再 root)、/tmp 仍可写(命令照跑)、/etc 仍只读。
- Gate:tsc clean;security.test + browser-capability.test 各加 `--user` 断言;gateway 190 全绿。

### Slack 活体闭环:接线 + Socket Mode/ack-before-dispatch 活体验证 (2026-06-13)

**第三次「未接线」同类发现:** `SlackConnector`(Phase 12 写好+单测过)从未被 `GatewayBot.start()`
实例化 —— 入口只手接了 Telegram/Discord/Email。`WebhookConnector` 同样未接。`ConnectorRegistry`
只被 DeliveryRouter(出站)用,入站没走它。修复:照 Email 范式在 `gateway-bot/src/index.ts` 接 Slack
(SLACK_APP_TOKEN+SLACK_BOT_TOKEN 在场→check(auth.test)→start()→dispatchMessage,sessionKey=slack:<chat>)。

**活体验证(真实 SlackConnector.start() 路径,本机直连 slack.com):**
- 自验 1–3:auth.test→bot @memex(U0BA827GTSR)/team Memex;apps.connections.open→WSS url（Socket Mode 已开）;
  WSS 首帧=hello。
- **ack-before-dispatch 决定性证据**(可注入 wsFactory 包真 socket + 故意 sleep 4s 压力):
  `← IN events_api envelope_id=X text="hi"`(56.368)→ `→ OUT ack envelope_id=X`(56.368 同毫秒)→
  `onMessage`(56.369,后于 ack)→ sleep 4s 窗口内**同 envelope_id 零重投** → chat.postMessage 回复(用户目视确认）。
  即:ack 严格先于 dispatch，且 ack 被 Slack 接受（否则 4s 内必重投）。这是单测测不到的部分。
- Gate:tsc clean;gateway-bot 62 测试绿（默认无 SLACK_* env，既有行为不变）。

**残留:** ① SlackConnector 用裸 fetch，**不走 channel-http 的代理/IP 回退**（Telegram/Discord 走了）——
slack.com 一般不被墙故本次直连成功，但 GFW/代理环境下是 DRY 缺口，应让 Slack 也路由过 channelDispatcher。
② 无白名单门禁（任何能私信 bot 的人都得到回复）——生产缺口，归信任隔离待办。③ WebhookConnector 仍未接线。

### Slack 残留 1 收口:fetch + WSS 改走 channelDispatcher (2026-06-13)

SlackConnector 原用裸 fetch / 裸 WebSocket(无代理/IP 回退,DRY 缺口 vs TG/Discord)。改:
- 默认 fetchFn 包一层 `dispatcher: channelDispatcher('SLACK_PROXY', ['slack.com'])`(auth.test/
  connections.open/chat.postMessage 全覆盖);注入式 fetchFn(测试)不变。
- 默认 wsFactory 改 `new WebSocket(url, { dispatcher: channelDispatcher('SLACK_PROXY', [host]) })`
  —— undici WebSocket 运行时接受 WebSocketInit{dispatcher}(ctx7 查 undici 官方文档确认),DOM lib
  类型只声明 protocols 故 `as unknown as string[]` cast;注入式 wsFactory 不变。
- 两条都改:只改 fetch 不改 WSS 的话,代理用户 API 通了 socket 仍连不上 = 白改。
- 活体验证(无代理→channelDispatcher 返回 primary Agent):check()→auth.test ok、connections.open
  via dispatcher→WSS url、**WSS via dispatcher→hello**。三条全通,直连 slack.com 未受影响。
- Gate:tsc clean(RequestInfo 类型本项目不可用,改 `Parameters<typeof fetch>`);gateway-bot 62 测试绿。

### 硬化 Telegram:入站 allowlist 边缘门 + webhook secret (2026-06-13)

承接 Slack 残留 ②(无白名单门禁)—— Telegram 同病且更危险:`TELEGRAM_BOT_TOKEN` 一设,
**任何找到 @memememex_bot 的人都能直达 dispatchMessage → 会话核心 →(execute_bash)**。trim tab =
入站 allowlist 边缘门。不重复造轮子:港 hermes 姿态(roam_retrieve→`gateway/run.py
GatewayRunner._is_user_authorized` + `TestAllowlistStartupCheck`),只港核心,不全量搬 900-token 多平台巨函数。

**hermes 姿态(忠实移植):** allowlist 设了→只放行列内(其余丢弃,**fail-closed at the edge**);
空→放行所有但 start() 打**一次性安全告警**(开放 agent 不该静默全网可达);`*`→显式 allow-all 且消告警。

**改动:**
- `channel-allowlist.ts`(新,channel-agnostic 故 Slack/Discord 后可复用——hermes 也是单一授权路径):
  `parseAllowlist` / `isChatAuthorized`(返回 {allowed, reason}) / `allowlistStartupWarning`。
- `adapters/telegram.ts` `startLongPoll`:加 `allowlist` option;启动告警;**dispatch 前**门控,
  未授权 chat 直接 `continue`(去重日志 `lastDeniedChat`,防 spammer 刷屏)——**永不到达 onMessage/agent**。
- `startWebhook`:同 allowlist 门 + `TELEGRAM_WEBHOOK_SECRET`(setWebhook 带 secret_token,
  POST 校验 `X-Telegram-Bot-Api-Secret-Token`,拒伪造 update);顺带 setWebhook 裸 fetch→telegramFetch
  (GFW 可达性,同 Slack 残留①的 DRY)。
- `index.ts`:读 `TELEGRAM_ALLOWED_CHATS` 接线进两条路径。`.env.example`:补 3 个 Telegram 变量文档。

**Gate:** root tsc clean;gateway-bot 73 测试绿(原 62 + allowlist 11:纯逻辑 7 + 适配器 deny-not-dispatched/
allow-dispatched/启动告警 3 + …)。

**活体闭环(真实 DM + 真实网络 + 出货代码):** 一次性 harness 跑真 getUpdates(telegramFetch 到达
api.telegram.org,bot @memememex_bot),对同一条真实入站消息跑两次出货的 `isChatAuthorized`:
- `← IN chat=513580037 text="123"`
- vs deny-list `['999999']` → **allowed=false reason=denied**(会被丢弃,不到 agent)
- vs allow-list `['513580037']` → **allowed=true reason=listed**(放行)
- → OUT 回复用户目视确认。verdict=PASS。门的两条边都对真实 Telegram 输入验过。harness 用后即删。

**残留:** ① webhook secret 校验**未活体**(本机无公网 URL/未跑 webhook 模式)= unverified-live,
落地条件=有公网入口时 POST 带/不带 secret 各一次。② allowlist 仅 gate chat_id(DM 即 user);群组按
from.id 细分留作 YAGNI,需要时再加。③ Slack/Discord 仍未上同一个门(channel-allowlist.ts 已备好复用)。

---

## Onboarding: model pick-list (2026-06-14)

**触发:** 用户跑 `memex onboard` 反馈顺序错 —— 还没问 API key 就让手敲 model name
(`meta/llama-3.1-8b-instruct`)。应先问 key,再用 key 拉 provider 的 `/models` 让用户选。

**新顺序:** `provider → (custom url) → API key → 拉取 /models 选单(推荐置顶) → ...`
(对齐 Hermes `hermes model` 选单流,hermes-research-B §1.2/§1.4 的 `ProviderProfile.fetch_models()`)。

**改动:**
- `packages/shared/src/llm/fetch-models.ts`(新):best-effort 拉 OpenAI-compat `/models`
  (`{base}/models` vs `{base}/v1/models` 按 base 是否已含 `/v\d` 版本段自动判定)及 Anthropic
  固定 `/v1/models`(`x-api-key`+`anthropic-version`)。**永不抛**,任何失败返回 `[]`。
- `onboard.ts`:`collectApiKey` 改返回 `{ref, secret}` —— `ref`(`${VAR}`)进 config,`secret`
  仅内存内供这次拉取用、不落盘(仍只进 .env)。key 采集上移到 model 前。新 `selectModel()`:能拉到
  就 `select`(`defaultModel` 命中列表则置顶标 recommended,末尾留"手动输入"逃生口);拉不到回退原 text。
- 测试:fetch-models 6 单测 + onboard 选单路径 1 用例;现有 4 onboard 用例靠 fetch stub-reject 走回退,断言不变。

**Gate:** root tsc clean;`fetch-models.test.ts`(6)+ `onboard.test.ts`(5)= 11 绿。

**残留(unverified-live):** 真实 onboarding 未跑活体(本机 LLM key 此前被吊销,待用户配新 key 后验证
真实 provider 的 `/models` 选单)。`docs/USER_MANUAL.md` §5.1 向导步骤已同步新顺序。

### Embedding provider breadth (same session)

**触发:** 用户在 NVIDIA(不能 embed)→ embedding picker 只看到 3 个(OpenAI/Ollama/Gemini),要求增加。

**根因:** picker 过滤 `supportsEmbedding && defaultEmbeddingModel !== undefined` —— 把"能 embed"和
"有推荐模型名"混为一谈,挡掉了已标 `supportsEmbedding:true` 但无默认模型的 5 个(vllm/lmstudio/
llamacpp/omlx/custom)。

**改动:**
- picker 过滤放宽为 `p.supportsEmbedding`;无默认模型者标 `(choose a model)`,选中后用 `selectModel`
  (复用 chat 的 fetch /models 选单)补问模型。`custom` 还需补问 baseUrl → 成为任意 OpenAI-compatible
  embeddings 端点(Voyage/Cohere/Jina…)的逃生口,写入 `embedding.baseUrl`。
- `selectModel` 泛化:`(api, baseUrl, secret, recommended, purpose)`,chat/embedding 共用。
- 加 GLM `embedding-3`(supportsEmbedding→true)—— 模型名经 LangChain/Spring AI/langchain4j 多源印证。

**有据不加(防 fabricate):** DeepSeek(官方仓库还在 *请求* embedding API;"deepseek-embedding-v2"
仅见第三方博客)、Kimi/OpenRouter/Anthropic(确无)、NVIDIA(`/embeddings` 需 `input_type`,要改 embed
管线,超范围 —— 沿用既有注释的排除理由)。

**结果:** embedding picker 从 3 → 9 个 provider。`provider-profiles.test.ts`「hosted 必须有默认模型」
对 GLM 仍绿;新增 custom-embedding 用例。20 测试绿,root tsc clean。

### Local-provider endpoint confirmation (same session)

**触发:** 用户本机 llama.cpp embedding 在跑,onboarding 选 "llama.cpp (local)" 却 "Couldn't list
models"。

**根因:** 本地 provider 的 baseUrl 是 registry 写死的(llamacpp=`http://localhost:8080`),而 onboarding
**只对 custom 问 URL**,本地一律用默认 → 端口/绑定不符就探不到;且就算手敲模型名,写进 config 的 baseUrl 仍是
错的,运行时 embedding 照样失败。Windows 还叠加 `localhost`→IPv6 `::1` 优先、而服务器多只绑 `127.0.0.1`
→ 连接被拒(同 channel 连通修复的 undici/IP 族问题)。

**改动:** 新 `resolveBaseUrl(profile)` —— custom 必填、**local 确认/可改(默认预填)**、cloud 用默认。
chat 与 embedding 两条路都接;返回的 URL 既喂 `fetchModels`(拉模型)又写进 config(运行时同端点)。
embedding section 的 baseUrl 写入条件改为「与 profile 默认不同就写」(支持本地改端口,不止 custom)。
USER_MANUAL §5.1 补本地端点确认 + `localhost`→`127.0.0.1` 排错提示。

**Gate:** 新增 llamacpp 改端口活体路径用例(stub 只认 `127.0.0.1:8081/v1/models`,证明改后的 URL 流进
fetchModels 且持久化);onboard 7 + fetch-models 6 + provider-profiles 8 = 21 绿,root tsc clean。

### NVIDIA embeddings via bge-m3 (same session)

**触发:** 用户指出 NVIDIA 也有 embedding,picker 里却没它。

**核实(决定性):** NVIDIA 的 NV-Embed-QA / E5 检索模型**强制 `input_type`**(query/passage),OpenAI 协议没
这参数 → 通用 embed 路径会 400(这是之前排除它的真实原因)。但 NVIDIA 也托管对称模型 `baai/bge-m3`,其
NIM `/embeddings` 只收 `{model, input}`,**不需要 input_type**(取自 docs.api.nvidia.com/nim/reference/
baai-bge-m3-invoke:input 必填,model/encoding_format/truncate 可选,无 input_type)。

**改动:** NVIDIA `supportsEmbedding: true` + `defaultEmbeddingModel: 'baai/bge-m3'`,注释写明对称模型走通用
路径、asymmetric nv-embedqa 仍需 input_type 故不作默认。**副作用(正向):** 用户 chat=NVIDIA 时 `canReuse`
变 true → embedding 直接走 reuse("用 NVIDIA(bge-m3)"),同 key,不再显示"can't create embeddings"。

**有意未做:** asymmetric nv-embedqa 的 input_type query/passage 全链路接线 —— embed(text) 接口对称、存/查
不分,要改接口+~6 调用点(semantic/backfill/procedural/template/reflect worker + memory route)+测试,
跨切面大改,收益边际(bge-m3 已是优秀对称模型)。需要时再单开。

**Gate:** NVIDIA-reuse 用例锁定(provider=nvidia + embedding=nvidia/bge-m3);onboard 8 + provider-profiles 8
= 16 绿,root tsc clean。bge-m3 输出 1024 维,padToSchemaDims 补到 1536。

**残留(unverified-live):** bge-m3 经 NVIDIA key 的真实 `/embeddings` 往返未活体(用户有 key 可验)。

### Onboarding zoom-out: same-class sweep (same session)

**任务:** "fix all similar issue for onboarding process" —— 抽象一层,扫同一类缺陷。

**缺陷类定义:** onboarding 假设/写入了运行时够不到的东西,或发起在真实环境会失败的网络调用。

**模块图(Memex 词汇):**
- `cli/onboard.ts runOnboard` = Onboarding TUI,只写 `~/.memex/config.json`(provider registry + gateway + embedding + channels),不写图。
- SSOT = `shared/llm/provider-profiles.ts PROVIDER_PROFILES`(provider 能力声明:baseUrl/envVar/default(Embedding)Model/local/supportsEmbedding)。
- 消费侧:`shared/llm/from-config.ts`(buildChatProvider/resolveEmbeddingEndpoint)、`cli/doctor.ts`(checkProviders/checkEmbedding 探活)、`gateway-bot`(channels)。
- 网络硬化 SSOT = `gateway-bot/channel-http.ts`(resolveProxyUrl + telegramFetch:SNI 保留 IP 回退 + DoH)。

**修复(本 commit):** embedding **reuse** 路径丢弃已编辑的本地端点 —— `{provider,model}` 没写 baseUrl,
而 resolveEmbeddingEndpoint 路径#1 命中 `provider` 后回退 profile 默认端口,忽略用户改的端口(如 ollama 改
:11435)。同 embedding-other baseUrl 持久化的同类 bug。修:reuse 段在 chatBaseUrl≠profile 默认时一并写入。
新增 ollama 改端口 reuse 用例锁定。

**已核实在 parity(非 bug):** doctor `checkProviders`(probeUrl=prov.baseUrl??profile)、`checkEmbedding`
(走 resolveEmbeddingEndpoint 读 emb.baseUrl)—— 修完 reuse 后都读到持久化的编辑端点,与运行时一致。

**记录为 finding(本轮未修,需更大决策):** `cli/connect/telegram.ts validateBotToken` 用裸 `fetch` 打
`api.telegram.org/getMe`,而运行时通道已用 `telegramFetch`(channel-http.ts)硬化(代理/IPv6/SNI 回退)。
onboarding 的 Telegram 步在受限网络可能误报"validation failed"。**未修原因:** telegramFetch 在 gateway-bot
包,CLI 复用需跨包(移到 @graph/shared 或加依赖,带 undici)= 结构改动有 blast radius;且该步可选、失败仅降级为
"稍后 memex connect telegram",非阻断。落地条件:把 channel-http 提到 @graph/shared 时顺带接线。

**Gate:** onboard 9 测试绿,root tsc clean。

### Reuse-embedding model choice (same session)

**触发:** 用户选 NVIDIA LLM 后,embedding reuse 显示"Use NVIDIA (baai/bge-m3)"硬编默认模型,觉得是强制
自动选,想能选自己倾向的 embedding 模型。

**改动:** reuse 选单加第 4 项 `reuse-pick`("Use <provider>, choose a different model")。reuse 仍一键
接受推荐默认(快路径不变);reuse-pick 走 selectModel(默认置顶 recommended,不强制)列出 provider 的
模型让用户选(如另一个 NVIDIA embed 模型)。两条都带编辑过的本地端点。

**取舍:** 没把 reuse 直接改成"每次都 selectModel"—— 那会逼所有 reuse 用户翻 121 个混合模型;多数人就用
bge-m3。4 选项保留一键默认 + 按需选择,respects 两类用户。NVIDIA 非对称模型(nv-embedqa)若被 reuse-pick
选中运行时需 input_type 会失败,但属用户显式选择,recommended(bge-m3)已置顶标注。

**Gate:** reuse-pick 用例锁定(选非默认 nv-embed-v1);onboard 10 测试绿,root tsc clean。

### systematic-debugging: cloud /v1 path doubling (ROOT CAUSE) — same session

**触发:** 用户 "nvidia不是一個孤例" + /systematic-debugging。要求找 NVIDIA 误分类背后的系统性根因。

**Phase 1 证据(curl 实测,非推理):**
| URL | 结果 |
| nvidia/v1/embeddings | 400(路径存在,空body被拒) |
| nvidia/v1/v1/embeddings | 404(翻倍) |
| openai/v1/chat/completions | 401 | openai/v1/v1/chat/completions | 404 |
| openrouter/v1/embeddings | 401 | openrouter/v1/v1/embeddings | 404 |

**根因(系统性,比 flag 漂移更深):** `OpenAICompatibleProvider` 硬编 `${baseUrl}/v1/chat/completions`
和 `${baseUrl}/v1/embeddings`,但所有云 profile 的 baseUrl 已含版本段(openai/v1、nvidia/v1、gemini
/v1beta/openai)→ 运行时发**翻倍路径** → 严格网关全 404,chat+embedding 双双失败。

**为何隐藏(Phase 2 工作/损坏对比):** ① 本地 provider(ollama:11434/llamacpp:8080/…)baseUrl 无 /v1
→ `${base}/v1/...` 正确,而活体测试全是本地;② DeepSeek 网关宽容(/v1 与裸路径都 401);③ 我新写的
fetchModels 已做版本检测(所以选单能列 121 个)——但运行时 embed()/chat() 没有,两者对 URL 契约不一致。
**关键后果:** 我之前的 NVIDIA embedding fix(525e004f)运行时 404,非功能性 —— 这正是"nvidia 不孤"的真义。

**Phase 4 修复(at source,failing-test-first):** 抽 `openai-url.ts :: openaiUrl(baseUrl, route)` 单一规则
(检测 `/v\d` → 已版本化则直接拼 route,否则补 /v1)。provider chat+embed 与 fetch-models 共用,全码库统一
一条 URL 规则。新增 openai-compatible.provider.test.ts 6 例(版本化云 base 不翻倍×chat/embed/gemini、
裸 host 补 /v1×chat/embed、尾斜杠不翻倍)—— 先 RED(4 fail 显示 `/v1//v1/`)后 GREEN。Anthropic provider
不动(base 恒裸,不属翻倍类,改即 scope creep)。

**Gate:** llm 全套 54 测试绿(含新 6),root tsc clean。Anthropic/local/DeepSeek 行为不变。

### Flag-drift audit close-out: OpenRouter + MiniMax (same session)

完成 supportsEmbedding 全量审计(5 个标 false 的 provider 逐一核实):
- anthropic=false ✓(无端点)· deepseek=false ✓(无端点,官方仓库仍在请求)· kimi=false ✓(无原生端点)
- **openrouter=false ✗→true**:2025 标准化了 OpenAI 形 /embeddings(curl 401=存在;翻倍 404)。默认
  `openai/text-embedding-3-small`。**flag 漂移**(注册表写早了,OpenRouter 后来才加)。
- minimax=false ✓ **但属 nuanced**:embo-01 存在却需 query/db 类型参数(非对称,同 nvidia nv-embedqa),
  对称 embed() 满足不了。在 profile 注释写明"非疏漏",防未来被天真"修正"。

回归护栏:provider-profiles.test 锁 openrouter+nvidia 的 supportsEmbedding/defaultEmbeddingModel,
防再次被静默隐藏。**审计结论:flag 维度只有 OpenRouter 一处误分类,现已穷尽。**

**Gate:** provider-profiles 9 + onboard 10 = 19 绿,root tsc clean。

### Onboarding Next-steps: product command, not the dev launcher (2026-06-14)

**触发:** 用户指出一键应用的 onboarding 收尾提示 `Start Memex: npm run dev` 暴露了开发者命令,不该给终端用户看 `npm run`。

**修复(外科):** onboarding "Next steps" 第 2 步 `npm run dev` → **`memex console`**(已存在的产品命令:
拉起整栈 + 开浏览器,内部委托 dev stack)。顺带合并原"start + 手动开 URL"两步为一步。同一泄漏在
`console.ts:33` 用户可见输出("starting the stack (npm run dev)…")——因现在把用户导向 `memex console`,
该行成下游,一并改为"starting it…",保留真实的 repo-root 约束提示。代码注释里的 `npm run dev` 保留(面向
开发者)。USER_MANUAL §Running 的 `npm run dev` 不动(dev/operator 文档,语境正确)。

**残留 finding(未修,更大产品缺口):** `memex console` 底层仍 spawn `npm run dev`,需 repo-root + npm —
真正"一键打包"(无 repo 依赖的 `memex start`)是 deploy 弧的事(ROADMAP 15-deploy),非本次范围。
capability 预设的 follow-up(`npm install -g agent-browser`)是该工具自身安装方式,非我们的命令,保留。

**Gate:** onboard 10 测试绿(note 被 mock,不锚文本),root tsc clean。

---

## 2026-06-14 自主 GOAL — Phase 21+22 剩余收口 (GH #27 + #28)

**范围裁定（用户确认）：** 「所有已讨论但未开工的开发」= #28(workspace/project 深度集成) + #27(console 写路径/Now 美术)。
显式排除：#24(PARKED,缺活体 LLM)、#26(icebox 明确不实现)、#25(epic 设计门要求先钻 X 再切片)。

### #28 workspace-project 深度集成
- **#28-1 execute_bash cwd→project**：新 `packages/shared/src/scope-project.ts`(`projectFromCwd`/`recordScopeProject`/`isProjectArchived`)。
  在 execute_bash 的 local backend 分支以 first-write-wins 写 `scope_lineage.project`。tmp/ephemeral cwd → 不记 project。
  决策：project 值 = **绝对路径**(稳定分组键 + 支持 §11.3 存在性检测)；**不做 path+ctime 身份方案**(与 memory `project_workspace_artifact_model` ⑦ 一致：存标签、靠图连通性自然分簇)。
- **#28-2 per-channel provider 路由**：新 `buildChannelChatProvider(config, platform)`(from-config.ts)。
  **架构决策**：ADR-54「服务端单应答者」下,路由发生在 **gateway chat 端点**(provider 所在处),按 `principal`(X-Agent-ID=`<platform>::<chatId>`)解析 platform→选 channel provider,否则回退默认。
  ROADMAP 原文「gateway-bot 路由」是简写,真正 seam 在服务端。gateway index 按 platform 缓存 provider 实例。
- **#28-3 forest/artifacts 按 project 分组**：forest 新增 `projects[]`(basename 命名 + archived);artifacts `listAllArtifacts` LEFT JOIN `scope_lineage.project`;artifacts 路由附 `project_archived`。
- **#28-4 onboarding 文件夹根**：新 `packages/shared/src/workspace.ts`(`ensureWorkspaceRoots`),onboard 写 config 后为 `console`+每 channel 建 `<profileDir>/workspaces/<name>/`(artifacts/ + AGENTS.md,幂等不覆盖)。
- **#28-5 懒墓碑**：`isProjectArchived`(existsSync + 5s 缓存)= 投影时检测,**图零写**。意外删=archived 显示;故意删走 ADR-43 erase(现成)。

### #27 console-redesign 剩余
- **#27-1/2 Appendix-A 写路径**：`POST/DELETE /v1/sys/llm-overrides`(sys.ts),index.ts 用 `tokenAuth` 仅门控写动词(GET 投影开放,已脱敏)。
  **Fail-closed(§6.5)**:坏 JSON/空 override/类型错 → 400 *写入前* 返回,绝不持久化半成品凭证。`/v1/sys/config` 增 `llm_overrides`(脱敏)+ channels `.llm`。
  UI:`LlmSettingsForm.tsx`(chat+embedding 槽,password+show/hide,提交态,disabled,error surfacing,「重启生效」诚实提示)。
  **生效语义偏离 Appendix A**:Appendix A 想「gateway 进程内即时」,但 provider 在构造时读一次,跨路由 getter 重构对安全敏感写面风险过高。
  落地为**持久化即时 + 重启生效**(gateway+workers 一致),UI 明示。热重载留作独立基础设施项(Appendix A 自身已把软重启判出范围)。
- **#27-3 Now 节点美术**：**art-selection 决策**=**程序化 2.5D 状态精灵**(无外部资源),非导入 Kenney/AI-Town PNG 表。
  依据:§9 显式把 sheet 选型判为待决「素材候选」,#27 称美术为「design pick」。程序化=零二进制资源 + 全 a11y(色+形+脉动三通道)+ reduced-motion 安全 + 保留 `drawImage` seam 供日后换 CC0 sheet。
  ForestCanvas 节点增:active 脉冲(thinking)/converged 勾(done)/suspended 警示「!」字形。

### Gate
- 全量(非 console)707 测试绿(104 文件;基线 682 + 新增 25:scope-project 5 / workspace 3 / channel-provider +2 / chat 2 / sys 4 / forest +2 / 其余既有)。**零回归。**
- root tsc clean;console tsc clean;**console `next build` clean**(13 路由)。
- **DB 活体 journey**(`scripts/journey-workspace.mts` vs graph_test)10/10:recordScopeProject 幂等、forest projects+archived、artifact project 继承+archived、llm-overrides fail-closed、config 投影。

### 遗留 / BLOCKED（活体边界,与 snapshot §5 一致）
- **#27 AC4 真 LLM + 浏览器活体视觉验证 = BLOCKED**:本机无可用 LLM(Gemini key 被吊销 / Ollama 未装,见 `project_console_live_test_session`)+ 无浏览器活体。
  逻辑层已 logic-done(单测+DB journey+build 全绿);live-done 待用户配可用 provider 后跑 Now 画布 + 写表单真存。
- per-channel LLM **gateway 进程内热生效**:刻意留作独立基础设施项(见上 #27-1/2)。

---

## 2026-06-15 自主 GOAL 续 — Now 图 3D 翻案 + 交互稳定性修复

**触发**：用户指出当初选 react-force-graph 正是为 3D 视图,现有 `react-force-graph-2d` 是平面;且报 bug「跟图互动时节点突然失控放大」。先查 ctx7 文档(`/vasturiano/react-force-graph`)确认 3D 能力。

**交互 bug 根因（trim tab）**：`onEngineStop` 每次 SSE 脉冲 reheat 后重复 `zoomToFit`——节点少时 fit 强行 zoom-in→节点暴胀 + 抢走用户相机。
- 修复①**fit-once**:`fittedRef` 仅首次 settle 取景,之后相机全归用户(永不 refit)。
- 修复②**diff-before-reload**:`graphSignature`(id:status:size + link 端点)签名,脉冲只在签名变化时 setData→闲时脉冲不再 reheat/抖动。
- 两修复对 2D/3D 同源,故随 3D 重写一并落地(非 throwaway)。

**3D 翻案**：`react-force-graph-2d` → `react-force-graph-3d`(ThreeJS/WebGL)。新增 deps `three@0.184`/`three-spritetext@1.10`/`react-force-graph-3d@1.29`(单一 three 副本,无多实例 footgun)。
- 共享 `lib/graph3d.ts`:hex 状态调色板(ThreeJS Color 不吃 oklch)、`registerBloom`(UnrealBloomPass 动态 import,reduced 关)、`graphSignature`、`makeLabelSprite`、`prefersReducedMotion`。
- `UniverseCanvas`/`ForestCanvas` 重写:默认球体(nodeColor/nodeVal)+ bloom 辉光 + 方向粒子 + spritetext 标签(星系/根常显,其余 hover tooltip)+ hover 链 highlight + fit-once + diff-reload + reduced-motion 门。
- 类型 shim:`types/three-addons.d.ts`(UnrealBloomPass `.js` 子路径在 moduleResolution=bundler 下无类型);SpriteText.position 经 `makeLabelSprite` 内 cast(three Object3D 类型不总穿透 three-spritetext re-export)。

**Gate**：console tsc clean;**console `next build` clean**(13 路由,`/now` 静态 + ForceGraph3D ssr:false);root tsc 不受影响(console 独立 tsconfig)。
**设计**:CONSOLE-REDESIGN §6.5 改写为 3D 引擎 + §7 加翻案行 + 交互修复段。
**遗留**:贴图 CC0 sprite(Kenney/AI-Town)仍是 seam(makeLabelSprite/nodeThreeObject 可扩);3D 活体视觉验证待用户本机跑(无 LLM 也能看 Now 画布,但需 dev server)。

## 2026-06-15 — #27 AC3 Now node art: decision (3D-native vocabulary over 2D sprites)

Goal /execute-goal reconciliation found #27/#28 mostly already shipped in 63a4b7f4.
Only genuine remaining dev = #27 AC3 (Now node sprite art). Decision (mid-high
confidence; specimen+research backed per goal mandate):

**Implement a 3D-native node visual vocabulary** (custom geometry per node kind +
status-driven emissive/opacity/particles), NOT flat 2D Kenney/AI-Town sprite
billboards.

Evidence:
- Specimens (agentmemory/hermes-agent/iii/gsd-2/headroom) are agent/memory backends —
  none has a 3D graph viz, so no specimen precedent either way (stated, not fabricated).
- Research (ctx7 /vasturiano/3d-force-graph): first-class node customization is
  nodeThreeObject → THREE mesh/material (geometry + emissive + opacity + per-node
  particles). Flat THREE.Sprite billboards are the 2D-era seam, not the 3D idiom.
- CONSOLE-REDESIGN line 124 explicitly sanctions 3D-equivalent implementation over
  literal 2D-era porting; line 120 calls the sprite-texture path a future "seam".
- Project-best: zero external CC0 asset dependency (no asset pipeline / attribution /
  bundle weight), aesthetic coherence with the UnrealBloom nebula.

Realizes §9 intent ("see what state the work is in") natively: galaxy(channel) vs
task geometry distinction + active/converged/closed/suspended material treatment.
Executed via ui-ux-pro-max skill (user mandate). Text left-aligned.

## 2026-06-15 — MemexTerminal Pi-embed build-out (ADR-57 / spike 009 / GH #25)

X 梁（工具执行 + 审批表面）= 从现状到 Hermes-like agent 的唯一阻塞设计。授权后
单弧动工，在 worktree `feat/memexterminal-pi-embed` 做完合并回 master（efa1817c..814f87c0）。
**之前的 state/.continue-here 停在 01-discuss「X梁待授权」，已过时**——本次会话刷新对齐。

**决议（fuller 会话，ADR-57 0066）**:
- **R-A 库内嵌**:MemexTerminal = 基于 `@earendil-works/pi-coding-agent` 的进程，
  in-process import MemexCore 函数，不走 MCP。
- **C3 图为工作记忆**:每 turn 从图投影注入 Pi，turn 末冲回账本；Pi 持有的 message
  list 从不是权威状态（Graph → Context 在 terminal 也成立）。
- **脑 = config-share**（纠正 ADR-57 原 D-2 in-process 委托）:Core 的 `LLMProvider` 是
  `chat(messages)→string`（非流式、非原生 tool-call），in-process 委托会让 Pi 丧失原生
  tool-calling → 否决。正解 = 共享 Core provider **配置**（baseUrl/apiKey/model/api）→
  写临时 models.json → pi ModelRegistry，Pi 直连同一 OpenAI 兼容 endpoint。
- **审批** = `tool_call` hook → `ctx.ui.confirm`（TUI）/ CommandGate 策略（headless）
  双写 `ApprovalService`，deny 返回 `{block:true}`；审计行是 SSOT，本地 confirm 是 UX 快路。

**真 Pi API（读 dist/*.d.ts 核实，非 docs）**:嵌入入口 = `createAgentSessionServices` +
`createAgentSessionFromServices({ noTools:'builtin', customTools, model })`；驱动 =
`session.prompt(text)`；工具 = `defineTool({name,parameters:Type.Object,execute})`；
hook = `ExtensionAPI.on("before_agent_start"|"agent_end"|"tool_call"|…)` 经
`resourceLoaderOptions.extensionFactories` 注册。`before_agent_start`=per-user-prompt
（kill-criterion 双绿），故注入点选它，冲回点选 `agent_end`（per-prompt，含整轮 messages[]）。

**五根线活体验过**（各带 run-*.mts 证明，packages/terminal-pi/src/）:
1. tracer(efa1817c) — 嵌入跑绿 + 触发粒度双绿。
2. provider-bridge.ts / run-nvidia(2ec4861f) — config-share，真 NVIDIA qwen3.5 经 Pi 回复。
3. run-c3.mts/run-ledger.mts/run-c3-loop.mts(9a809006..73f9d1ee) — 注入→冲回→闭环；
   fresh session 从图召回 "teal" = Graph 即工作记忆。
4. run-approval.mts(814f87c0) — 危险命令 hook block(executed=false) + approval_request
   denied + requested/denied 双审计落账本。

**用户锁定约束（本次会话）**:MemexTerminal **始终通过 `memex chat` 启动** → MemexTerminal
(Pi-embed，现包 `@graph/terminal-pi`) 最终取代 `@graph/terminal` 瘦客户端成为 `memex chat`
的实现，**非** `memex connect pi`。确认 ADR-57「後果」中 `terminal/index.ts` 的「`--agent`
retired」注释作废、需改写。命名 A 方案：Pi-embed 终态升为规范短名 `@graph/terminal`（真 rename
留到最终接线刀，需先到 REPL/`-m` 功能对等）；范围只动 terminal，不做全局 @graph→@memex。
`pi-extension` = BYO（`memex connect pi`，含 fork+shadow 排练模式），不动，核心+shell 稳后统一处理。

### Build-out line #4 — 绑真 execute_bash 进 Pi（D-5 量产第一步，2026-06-15）

**做法（消除双实现漂移，ADR-57 後果）**:
- 把 `server.ts` tool 8 内联的 execute_bash body 抽成 `gateway/src/mcp/execute-bash.ts`
  的 `runExecuteBash(pool,{command,scopeId,predecessorHash,cwd?})` —— 容器化/CommandGate/
  fail-closed/scrubEnv/账本写入全在一份里。MCP-over-HTTP tool 8 与 in-process Pi 两路**调
  同一函数**。gateway 加 `./mcp/execute-bash` 子路径导出。
- Pi 工具(`defineTool`)只吃 `{command}`,scopeId + predecessor tip 由 **terminal 闭包供**
  (C3:图归 terminal 所有,不让模型供 scope)。审批 hook 复用 run-approval 那套。
- 证明脚本 `terminal-pi/src/run-exec-bash.mts`。

**execute_bash 的图语义**:每次调用 = 图中**一个新 Entity + 一个 Snapshot**(event_type=
`memory_updated`,predecessor=当前 tip),非塞进已有点;被 block 的尝试同样产生独立点
(失败是一等 trail 数据)。

**活体三连全绿**(真 DB + 真 NVIDIA qwen3.5):
1. 良性 `echo` 经 `runExecuteBash` 端到端 + 结果落账本(backend=local)。
2. 危险命令审批门 block(run-approval.mts 已证)。
3. **裸 pi 内置压制**:`session.getActiveToolNames()` = 实际开给模型的工具集(区别于
   `getToolDefinition` 定义注册表 —— spike 残留把两者搞混,bash 是 defined-but-disabled)。
   验得 `rawExposed=[]`(bash/read/edit/write 全关),只暴露 `execute_bash`。**enabled≠
   registered 残留就此澄清并验证。**

**pi 自带 bash vs Core execute_bash**:pi bash = 宿主裸逃逸(无门/无容器/无 scrubEnv/无留痕,
vault KEK 会泄进子进程);Core execute_bash = CommandGate + docker network=none fail-closed +
scrubEnv + occWrite 留痕 + 审批。两者并存会让模型绕开全部安全 → 必须压制 pi bash。

### ⚠️ 待修(下一刀)——内嵌 embed 未与外部 `~/.pi` 扩展隔离

活体发现:`getActiveToolNames()` = `["spawn_task","complete_task","execute_bash"]`。前两个
是 **pi-extension(BYO)的工具**,根因 = 用户曾跑 `memex connect pi`,扩展装进
`~/.pi/agent/extensions/graph-runtime/`,**内嵌 MemexTerminal 会话经 createAgentSessionServices
自动发现并加载了 `~/.pi` 外部扩展**。
- 安全不破(裸 bash 仍关;spawn_task/complete_task 只代理 gateway MCP,非宿主逃逸)。
- 但**隔离破了**:embed 应只加载我们的 in-process factory,不该捞 `~/.pi` —— 正是「BYO 归 BYO」
  要避免的串台。
- **修法(下一刀)**:`buildSessionWithCoreBrain` 关掉外部 extension 自动发现(限定
  resourceLoader 只用传入的 extensionFactories)。属 embed 隔离独立主题,不阻塞本刀。

### Build-out #5 — embed 隔离修复(2026-06-15)

`buildSessionWithCoreBrain` 加 `EMBED_RESOURCE_ISOLATION`(noExtensions/noSkills/
noPromptTemplates/noThemes/noContextFiles)。读编译 loader 确认:`noExtensions:true`
只丢弃发现路径,inline `extensionFactories` 无条件 append → 我们的 factory 仍加载。
活体:getActiveToolNames 从 `[spawn_task,complete_task,execute_bash]` → `[execute_bash]`。
**决策(mid-high)**:embed 完全自洽,只从 Core 派生,不吸收 ~/.pi/cwd 资源(BYO 归 BYO +
产品确定性)。

### Build-out #6 — 组装真 MemexTerminal(脊柱,ADR-57 D-1/D-5)

**架构决策(high confidence,ADR 强制 DRY + pi 暴露 API)**:复用 pi 的完整
`InteractiveMode` TUI(聊天+流式+审批弹窗),不自研 loop/审批/TUI。`createMemexTerminalRuntime`
经 `createAgentSessionRuntime(factory,...)` 组装,factory 内 `createAgentSessionServices`
(config-share modelRegistry + EMBED 隔离 + systemPrompt + C3/approval factories) +
`createAgentSessionFromServices`(model + noTools:'builtin' + Core customTools)。

**落点**:`terminal-pi/src/terminal.ts`(脊柱:MEMEX_TERMINAL_SYSTEM_ROLE + makeC3Factory +
makeApprovalFactory + makeCoreTools + createMemexTerminalRuntime) + `index.ts`(入口:-m
单轮可脚本 / 默认 InteractiveMode)。provider-bridge 抽出 `buildCoreModelRegistry` +
`EMBED_RESOURCE_ISOLATION` 共用(不破坏 proof 脚本)。

**系统提示决策(mid confidence)**:terminal 用新 `MEMEX_TERMINAL_SYSTEM_ROLE`(agentic:
可用工具),**非** channel 的 `CONVERSATION_SYSTEM_ROLE`(ADR-54 故意非 agentic,明说"无法
调用工具",与 agentic terminal 矛盾)。不臆造纪律保留。

**C3 持久会话精修(mid-high)**:交互式会话里 pi 在会话内自持 message list(即"恰好活在
进程的每轮投影");故每轮 (a) processAgentTurn 记 user 进图 (b) 注入背景记忆块 (c) agent_end
冲回;**仅首轮**注入图历史 transcript(跨会话/scope 续接,之后 pi 自持避免重复)。run-c3-loop
的"每轮 fresh session"是证明构造,产品不丢弃 pi 会话内 list。

**修了一个真 bug(OCC predecessor)**:agent_end 原用 user 轮 hash 作 predecessor → 但
execute_bash 在 before_agent_start↔agent_end 间 append 了事件、移动了 tip → 用过期 hash
致 OCC 冲突,助手轮静默不落库(空回复)。run-c3-loop 无工具调用所以 userHash 恰是 tip,掩盖了
它。改用**当前 tip** 作 predecessor。

**活体验证(真 NVIDIA qwen3.5)**:
- `-m`:模型调 execute_bash(echo)→读输出→回 "The command printed exactly: memex-terminal-live"。
  全 agentic 链(脑/工具/审批/冲回/回复)通。
- **C3 跨进程**:turn1(进程A)存 teal → turn2(进程B,全新 pi session,同 --scope)纯靠图
  投影答 "teal"。组装终端端到端实现 Graph=工作记忆。
- typecheck 干净(仍仅 7 个旧 proof 脚本错误);InteractiveMode 交互路径需 TTY,留活体 journey。

### Build-out #7 — memex chat 接线 + cwd(2026-06-15)

`cli/src/index.ts` chat dispatch 从 `@graph/terminal`(瘦客户端)→ `@graph/terminal-pi`(agentic
终端)。改写瘦客户端「--agent retired」过时头注释(ADR-57 後果):per-surface 律下两者不冲突
(channel 核心非 agentic / terminal agentic),瘦客户端留作对话核心探针/fallback。execute_bash
改在终端启动 cwd 跑(coding 终端作用于用户项目),非 tmpdir。活体:`memex chat -m` 经真 cli 跑
execute_bash 报告输出。

### Build-out #8 — D-6 工具(2026-06-15)

**schedule_task 实现**(图原生):gateway-bot/cron.ts 抽 `upsertCronJob(pool,def)` +
`ensureCronRegistryScope(pool)` 独立函数(CronService 方法委托,单写路径),gateway-bot 加
`./cron` 导出。terminal schedule_task 工具(审批门控)append cron_job 到 registry scope,运行中
gateway-bot CronService.tick() fire(ADR-45)。活体:模型调用 → cron_job 正确落库
(schedule/prompt 对,readJobTips 可读)。审批工厂泛化:execute_bash 走 CommandGate 安全门;
其余(schedule_task)autonomy-gated,headless 放行(本地操作者 scripted 即同意)/TUI confirm。

**send_message 延后(设计决策,mid-high)**:正确实现需 ConnectorRegistry(活连接器在 gateway-bot
进程)。terminal 自建连接器会**重复起 bot inbound 消费者**(两进程抢同一 Telegram=真 bug)。
可选正解:(a)图原生出站 intent 事件 + gateway-bot 新投递消费者(新基础设施),(b)出站-only
registry(只调 .send 不 .start,但 gateway-bot 连接器构造是逐平台内联无统一 builder,且需配置
channel 才能活体验证)。两者都无法在本环境无配置 channel 下活体验证 → **不半成品**(违反 stable
mandate)。留作专门切片。schedule_task 已覆盖 D-6 的 autonomy-parity;send_message 是 outbound-parity,
delivery 依赖 channel 配置,与核心终端解耦。

### Build-out #9 — 收口验证(2026-06-15,自主 GOAL)

- **typecheck 全工作区 0 错误**(删除被取代的 5 个 tracer proof + 修 buildCoreModelRegistry
  不可移植返回类型 → 原 7 个 pre-existing 也清了)。console typecheck 0 错误(未触及)。
- **全测试套件 726 passed / 107 files,零回归**(gateway execute_bash 抽取 + gateway-bot
  cron 抽取均未破坏;mcp.test.ts execute_bash 经 runExecuteBash 仍绿)。
- **完整 agentic journey(真 NVIDIA qwen3.5)**:`memex chat -m "创建文件→写入→cat 读回→报告内容"`
  经真 cli → 终端自主多步执行(mkdir/写/cat),每步审批门控+落 trail,**文件真实落盘**,模型
  准确报告内容(并发现 echo 尾随空格)。完整因果链在图中可查。
- 其他活体:-m 单轮 / C3 跨进程 teal / schedule_task cron_job 落库 全绿。
- **唯一未活体**:interactive `InteractiveMode` TUI 需真 TTY(本环境无法驱动);其包裹的 runtime
  已由 -m 全验。留用户活体。
- **dev-mode 注记(非产品 bug)**:`memex chat` 经 tsx 从仓库外目录启动会因 workspace 路径别名
  (@shared/*)需 repo tsconfig 而失败;生产编译后路径已解析,从任意目录启动正常。execute_bash
  的 cwd=启动目录特性据此(coding 终端作用于用户项目)。

**MemexTerminal (Pi-embed) 弧收口**:ADR-57 D-1~D-5 全实现并活体;D-6 schedule_task 实现、
send_message 设计延后(channel 依赖);embed 隔离修复;memex chat 接线。剩余=interactive TTY
活体 + send_message 专门切片 + A-plan 最终 rename(到 @graph/terminal,需 REPL/-m 对等)。

### Build-out #10 — Memex "Observatory" 主题(2026-06-15)

身份层第一刀(用户确认 identity-layer over pi / theme-first)。`packages/terminal-pi/memex-theme.json`
= 完整 51-token pi 主题(派生 dark.json),Observatory 调色板:brass(signal/brand/prompt) +
run-green(success/agent) + rust(error) + indigo(memory/link) + parchment(text) on 暖深 chrome。
经 ui-ux-pro-max design-system 验证方向(Dark OLED + JetBrains Mono + "code dark + run green")。

**接线机制(读 pi .d.ts + 编译源确认)**:`createAgentSessionServices` 传
`SettingsManager.inMemory({theme:'memex', editorPaddingX:2})`(不写用户 ~/.pi,隔离保住) +
`resourceLoaderOptions.additionalThemePaths:[memex-theme.json]`(noThemes 下显式路径仍加载,
resource-loader.js L307-309 确认)。InteractiveMode.init() `setRegisteredThemes`+`initTheme
(settings.getTheme())` → 注册并选中 memex。

**可控面(pi Theme 系统能力)**:颜色(全 51 token:fg + 按元素 bg userMessageBg/toolSuccessBg…)、
边框/线条色(border/borderAccent/borderMuted)、输入框水平 padding(editorPaddingX)。**不可只靠
主题改**:消息垂直间距(需 custom MessageRenderer)、整屏背景(终端 app 自身,非 pi)。

**验证**:typecheck 0;build smoke(无 LLM)= runtime 40ms 建成 + `settings theme=memex` +
`registered themes=['memex']` + `editorPaddingX=2`(主题必生效,InteractiveMode 会注册+选中)。

**⚠ 环境 BLOCK(非代码)**:NVIDIA endpoint 本会话期间不可达(直连 curl 25s 0 字节超时) →
用户先前的 "Unexpected end of JSON input" + -m 挂起都是这个 provider 中断,**不是主题/代码**
(撤掉全部主题改动 -m 仍挂 = 铁证)。**视觉 TUI 渲染 + 真 LLM 活体 = BLOCKED 待 NVIDIA 恢复
/本地 Ollama**。主题已 build-verified,待视觉确认。

### Build-out #11 — 品牌 header/footer + 消息间距裁定(2026-06-15)

身份层第二刀。`makeChromeFactory(scopeId, modelLabel)` ExtensionFactory:`session_start` →
`ctx.ui.setHeader`(内联 Component:✦ MemexTerminal 品牌 + model + scope + brass 分隔线;主题色)
+ `ctx.ui.setStatus('memex', 'scope … · /memory · /console')`(追加进 pi footer,保留其 model/token)。
`hasUI` 守卫:-m/print 无 TUI 跳过。

**真 API(读 .d.ts)**:`ExtensionUIContext`(=ctx.ui)有 `setHeader/setFooter/setStatus/setWidget`。
Component 接口必需 `render(width)=>string[]` + **`invalidate()`**(非可选,踩了一次 typecheck)。
内联实现免 import pi-tui(嵌套依赖不可直接解析)。

**消息间距裁定(查尽公开 API)**:pi **不暴露**标准聊天轮的垂直间距 ——`registerMessageRenderer`
仅作用于 **custom message 类型**,标准 user/assistant 轮渲染是 InteractiveMode 内部(addMessageToChat),
无设置项(只有 editorPaddingX)。**不 fork InteractiveMode(守 ADR-57 DRY)**。替代 = 主题 per-message
背景(`userMessageBg` 等给消息独立色块分隔)。已如实告知用户。

**验证**:typecheck 0;build smoke = runtime 建成 + chrome factory 加载无错(session_start hasUI
守卫,-m 跳过);header 组件 render 结构预览正确。颜色/视觉布局待 TTY(NVIDIA BLOCK 同上)。

### Build-out #12 — config-share provider 解析修复 + Gemini 兼容(2026-06-15)

用户切到 Gemini 后 `memex chat` 报 `400 status code (no body)`。两层 bug,逐层修:

**Fix 1 — baseUrl/api 按 provider 解析(不再硬编码 nvidia)**:`resolveCoreProvider` 原硬编码
`api='openai-completions'` + `baseUrl ?? nvidia`,把 Gemini model 发到 **NVIDIA 端点** → 400。
改为镜像 Core 自己的 `from-config.ts buildOne`:`resolveProfile(entry)` → `api=profile.api`,
`baseUrl=entry.baseUrl ?? profile.baseUrl`,`apiKey=entry.apiKey ?? env[profile.envVar]`。
验:resolveCoreProvider 现解析 gemini → `generativelanguage.googleapis.com/v1beta/openai` +
openai-completions + GEMINI_API_KEY(不再 nvidia)。

**Fix 2 — Gemini openai-compat compat shim**:修对端点后仍 400。抓 pi 实际请求(globalThis.fetch
拦截)发现 pi-ai 发了 `"store"` 参数,Gemini 报 `Unknown name "store"`。根因:pi-ai `detectCompat`
的非标准 provider 清单**不含 Gemini** → 当通用 OpenAI → `supportsStore:true` → 发 store。
pi-ai 支持 model 级 `compat` 覆盖(openai-completions.js getCompat L957)。`compatFor(p)` 对
baseUrl 含 generativelanguage 的注入 Gemini-safe compat(supportsStore/ReasoningEffort/DeveloperRole/
StrictMode/LongCacheRetention:false + maxTokensField:'max_tokens')。验:**Gemini 纯对话活体通**("PONG")。

**⚠ 上游限制(非我可修)——Gemini thinking 模型 + 工具**:agentic 路径(execute_bash)下,工具
执行后的续请求 400:`Function call is missing a thought_signature in functionCall parts`。Gemini
thinking 模型(gemini-2.5/3.5-flash)要求把响应里的 `extra_content.google.thought_signature` 在
后续 assistant function_call 消息回传;**pi-ai 不做这个 Gemini 特有往返** → 工具用不了。
bridge/models.json 无法修(在 pi-ai 消息序列化层)。**建议**:agentic 终端用 **NVIDIA qwen**
(pi 原生全支持工具,之前 -m 全绿;本会话 NVIDIA 间歇不可达)或非 thinking 的 openai-compat 模型。
Gemini 适合纯对话,工具用 qwen。

**净结果**:config-share 现按 provider 正确解析端点(修了"什么 provider 都发去 nvidia"的真 bug);
Gemini 纯对话可用;Gemini 工具受 pi-ai 上游 thought_signature 限制。

---

## MemexTerminal TUI build-out (2026-06-15, /goal autonomous)

Landed the 4-surface TUI from the gsd-2 learning report (GH #25), built purely on
pi's `ctx.ui` extension layer (no InteractiveMode fork, ADR-57 DRY). Design via
ui-ux-pro-max: color-not-only (glyph+word+color), semantic Observatory tokens,
progressive disclosure (density), whitespace grouping, empty-states, consistent
glyph family (no emoji), copy-clean (inline panels no `│`; overlays use box).

New (packages/terminal-pi/src/):
- render-kit.ts — width/CJK-safe primitives on @earendil-works/pi-tui (added as a
  direct dep, pinned ^0.79.3; pi-coding-agent doesn't re-export them). renderPanel
  (copy-clean) vs renderFrame (overlay box).
- graph-snapshot.ts — cheap defensive graph queries (scope_lineage,
  execution_event_log, approval_request, procedural_memory). EVERY query wrapped:
  a missing migration yields a safe default, never crashes the terminal.
- graph-widget.ts — persistent aboveEditor "graph is working memory" widget;
  full/small/min/off density via /density (persisted to ~/.memex/terminal-agent/
  widget.json); snapshot cache + 6s timer + agent_end refresh; never awaits in render.
- outcome.ts — status-colored panel (complete/blocked/denied/failed); wired into
  approval-denied (set on deny, cleared on next agent_start).
- graph-overlay.ts — /graph (scope trail) and /memory (lessons) read-only
  scrollable overlays (esc/jk/g/G), mirroring gsd's GSDNotificationOverlay contract.

Decisions (≥mid confidence, specimen + research backed):
- Density cycles via /density slash command (stable) not a keyboard shortcut
  (avoids key-conflict risk; lower-risk than registerShortcut).
- Tool runs record as `memory_updated` events (graph-native — verified live:
  classifyEvent buckets them as memory, which is accurate to the data model).
- pi-tui added as direct dep rather than reimplementing ANSI/CJK width math.

Verification:
- 46 new unit/integration tests (render-kit 12, graph-snapshot 10, graph-widget 9
  + integration 3, outcome 5, graph-overlay 7). tsc 0.
- Live: `memex chat -m` runs clean with all 5 factories wired; snapshot/detail/
  lessons queries return REAL data (turns/events/breakdown/intent), not swallowed
  defaults; empty-state (0 lessons) works.
- KNOWN PRE-EXISTING FLAKE (not this change): `npm test` (parallel) intermittently
  deadlocks in nesting.test.ts/idempotency.test.ts — a DDL/migration concurrency
  race in code I didn't touch. `vitest run --no-file-parallelism` → 782/782 green.
  My terminal-pi tests never fail; they're pure/stub (no DB), they only shifted
  parallel scheduling enough to expose the existing race.

---

## Code-quality / architecture sweep (2026-06-16, /goal autonomous)

Driven by `/improve-codebase-architecture` (roam-precise) + a `/goal`. Baseline:
793 tests green, roam health 6/100, worst cognitive complexity `buildMcpServer`=161.

**Candidate #1 (shipped, 52cfd2ee) — deepen the MCP tool registry.** `buildMcpServer`
was the #1 complexity hotspot: 13 tools inlined as nested handlers in one 161-cx
function, unreachable for reuse → the Pi terminal re-declared execute_bash/
schedule_task (the drift ADR-57 consequence #3 named). Split into `mcp/tools/`:
each tool = a named top-level handler (own testable unit) + a factory binding it
to a Pool. `buildMcpServer` is now a thin registration loop (cx ~3, off the
critical list). Pattern validated against the **hermes specimen** (`tools/`
registry decoupled from the dispatch loop). Behaviour byte-for-byte preserved;
order preserved; env-gated tools (execute_bash/browser) return null when disabled.
Dropped the vestigial `ZERO_HASH` re-export (no consumers).

**Candidate #3 (shipped, 3e3767a5) — conservative dead-code sweep.** Deleted the
last orphan tracer proof `run-exec-bash.mts` + unused `renderBar`. Did NOT chase
roam's 80-dead-export list: hand-verification found false positives (`graphSignature`
IS used by the canvases — roam missed the `.tsx` imports), test-only seams, and
latent-unwired features (`DiscordConnector`, `recordConfigChange`) whose deletion
would silently remove capability. Verify-before-cut discipline.

**Candidate #2 (shipped, 71060fe4) — terminal de-dup, decision = NO rename now.**
`@graph/terminal` (thin readline) still earns its keep as the `npm run dev`
foreground + non-agentic conversation-core probe; the terminal-pi → @graph/terminal
rename stays a deliberate move gated on REPL/-m parity (per memory), not forced
under an autonomous goal. Cleaned only the real friction: stale USER_MANUAL §9
entry (`npx tsx packages/terminal/...` → `memex chat`) + the `--agent` guard
message (pre-ADR-57 `memex connect pi` → `memex chat`).

**Candidate #4 (deferred, documented) — test-only exports.** ~32 exports exist
only as test seams (implementation leaking past the interface). Lowest-confidence,
needs per-export judgement; mass-touching 32 seams under a no-regression goal is
the churn KISS/YAGNI warns against. Handle opportunistically when touching each
module, not as a sweep.

**Verification (goal exit criteria).** tsc 0 · full suite 793/793 serial (== baseline,
zero regression) · roam confirms `buildMcpServer` off the critical list · live E2E
acceptance journey 11/11 green against a fresh gateway booted from current source
(incl. acquisition gate + ask_user round-trip = the refactored autonomy tools'
services; ADR-49 regression gate vs the 2026-06-14 snapshot passed with zero metric
drift). New code runs completely and stably.

---

## Code-quality sweep — 3 iterations (2026-06-16, /improve + baseline×2)

Continued the roam-driven sweep, then re-ran the same detect→fix→verify loop twice
more per user directive. Each iteration: re-index roam → safe ≥mid-confidence
change → tsc + targeted tests + full suite (793) → commit. Final E2E journey 11/11
green against a fresh gateway booted from current source; ADR-49 snapshot gate
zero drift across all three.

- **Iteration 1 (bdec96a7)** — split `runMcpCommand` (cx 76) and
  `runCapabilityCommand` (cx 47) into per-subcommand handlers + thin dispatcher
  (same deepening as buildMcpServer). Fixed a stale `@see` in execute-bash.ts
  (server.ts tool 8 → tools/exec.ts) left by the prior session.
- **Iteration 2 (b8e5ac99)** — split `handleWsMessage` (cx 63, 16 returns) into
  handleSubscribe/handleUserMessage/handleAgentEvent, each typed on its narrowed
  WsClientMessage union member. Guarded by ws.test.ts (12 tests).
- **Iteration 3 (fead4250)** — no safe code win remained: every remaining hotspot
  is a React page component (WorkspacePage/Sessions/Universe/Forest — visual-
  regression risk, thin tests, visual verify partly blocked) or sensitive runtime
  with weak orchestration test coverage (GatewayBot.start has a history of silent
  "written-but-not-wired" bugs and NO test for start(); runOnboard is interactive;
  runConversationTurn is ADR-54 TRIPWIRE-protected). Refactoring any of those
  autonomously under a no-regression bar is higher-risk-than-reward — deliberately
  deferred. Iteration 3 instead fixed a genuinely stale doc: ARCHITECTURE.md §7
  listed 8 MCP tools (predated the Phase 20/ADR-53 autonomy family) — corrected to
  13 + the mcp/tools/ registry structure.

**Discipline notes (carried from the prior sweep):**
- roam's dead-export list is false-positive-dominated for this codebase (Next.js
  routing, JSX usage, and barrel re-exports all read as "no production consumers"
  — e.g. Input flagged dead while used by 80 places). Not used for deletion.
- Memory was NOT aggressively pruned: older "BLOCKED" session records are
  superseded in context by later entries and reflect what was true when written;
  wholesale rewriting is high-judgement / low-value churn that loses cross-session
  context. Surfaced rather than destroyed.

---

## B1 — L2 template consolidation (GH #24, 2026-06-16)

**Goal:** lift the 18-step learning curve off its plateau (40, one quirk short of
the 38 optimum). Root cause per paper §5.5: templates accumulate 1→10 and
`mem::reflect` injects a MIXTURE of partial corrected runbooks. Chosen design
(user-approved): option (a) crystallization-time merge-and-supersede into ONE
canonical runbook.

**Mechanism (final):**
- `template-proposal.worker.ts` onScopeClosed: on a low-conflict converged scope,
  look up the prior canonical template; if found, one extra LLM call (`mergeRunbooks`)
  folds this run's lesson into it as a superset of "X before Y" rules, the new
  canonical row is written, and the prior is superseded (append-only — old row kept,
  `superseded_by` set).
- `reflect.function.ts`: positive procedural recall (hybrid + BM25) now filters
  `superseded_by IS NULL` — without this, supersede was inert for recall (it was a
  latent gap: Ebbinghaus-decayed positives were also still being recalled). This is
  what makes consolidation actually remove old templates from injection.
- `memory-repository.ts`: `findMergeableTemplate` + `supersedeTemplate` added.

**Key iteration (intent-embedding → topology):** the first cut matched the prior by
INTENT embedding (cosine > 0.89, reusing the semantic-merge threshold). The first
18-step re-run exposed it: runs 2–5 reached 38/0 (the optimum the mixture never hit),
but 6–10 regressed (44/40/46/40/42) and never recovered. DB forensics: 7 canonical /
3 superseded — supersede fired only 3/9. Diagnosis: the LLM-written intent_summary
DRIFTS run-to-run, so embeddings fell below 0.89 and the merge missed ~2/3 of
repeats; the mixture re-formed (dominant cause) and merge-every-run also let a
stumbling run poison the canonical (secondary). Fix: match on the DETERMINISTIC WL
`topology_embedding` (cosine > 0.95). Same converged trajectory → identical canonical
graph → reliable consolidation; a stumbling run has extra rework events → different
graph → it structurally CANNOT match (or poison) the clean canonical. This subsumes
an explicit "clean-run gate" — note that orphan events are NOT a stumble signal here
(failed task attempts stay in the predecessor chain; only the terminal event is an
orphan).

**Tests:** 3 new in template-proposal.worker.test.ts (merge+supersede on topology
hit; no-prior no-op; works without an embedding provider since topology is
deterministic). All workers/memory tests green; full-workspace tsc clean.

**Validation (passed):** 18-step `curve 10`, topology-keyed:
events 42,42,46,40,40,40,38,38,38,38 / gateFails 2,2,4,1,1,1,0,0,0,0. The curve
descends to 38/0 and HOLDS it for the final four runs (the intent-keyed version hit 38
then regressed to 44/46). DB after the run: 1 canonical / 9 superseded = consolidation
fired on all 9 repeats (intent-keyed was 7/3). The 40 plateau is removed.
Raw: `.harness/analysis/faithful-ab/curve-1781580434975.json` (topology),
`curve-1781579091655.json` (intent, regressed — kept as the diagnostic record).
Paper updated: §5.6 + abstract + conclusion + provenance.

---

## B1 consolidation is variance-fragile; B2 + gate + hermeticity (GH #24, 2026-06-16 cont.)

**Correction to the B1 note above.** Its "Validation (passed): 38/0 holds" was a single
good DRAW, not a robust property. Re-running the same curve on byte-identical code collapsed
to 121 (turn cap, no convergence). Investigation:
- Ruled out pollution: the curve wiped only procedural_memory; episodic/semantic accumulated
  across runs and polluted recall. Fixed: hermetic cold start TRUNCATEs all memory tiers
  (`scripts/eval/*/run.ts`). Collapse persisted → not (only) pollution.
- Ruled out local-model degradation: the model is NVIDIA-hosted `openai/gpt-oss-120b`, not
  ollama. A probe confirmed it is **non-deterministic at temperature 0** (3 identical
  crystallization calls → 3 different outputs).
- Structural diagnosis: consolidation is a **closed feedback loop** (canonical updated from
  runs the canonical guided). Merge = prose→prose feedback → drift compounds → bimodal
  (38/0 or collapse; a collapsed run's canonical showed a hallucinated `verify_completion`
  step compounded across merges). No-merge = single-shot incompleteness → one bad run locks
  in a non-converging canonical → permanent collapse. **Merge drifts; no-merge collapses.**

**Two fix attempts, both falsified by the gate (reverted):**
1. Constrain the crystallization prompt to in-trace steps → fixed B2's hallucination but
   **regressed §5** catastrophically (the prompt is brittle/scale-sensitive). Reverted.
2. Remove the prose-merge (single-shot canonical per topology) → made §5 **worse**
   (permanent collapse from run 3). Reverted to the committed merge variant (b883fe8f), the
   more recoverable of the two. `template-proposal.worker.ts` is unchanged from b883fe8f.

**What shipped (loop-code-untouched, durable):**
- `scripts/eval/cli-precondition/` — B2: a real CLI precondition (install-before-use,
  enforced by a real node-stub `command not found`, not a synthetic gate). The loop learns
  it **robustly** (discovery failure 1 cold → 0, ten hermetic runs). Robust because the task
  is recoverable in 1-2 turns; a bad template can't lock in non-convergence.
- `scripts/eval/loop-gate.ts` + `npm run eval:loop` — statistical regression gate (converges
  AND does not collapse), because unit tests can't catch loop regressions (109 green through
  a collapse) and a non-deterministic loop has no single-number criterion.
- Hermetic cold start in both curves; `scripts/eval/README.md` + CLAUDE.md gate note.
- Paper §5.6 corrected (38/0 was a draw), §5.7 added (variance-fragility, B2, methodology),
  abstract/conclusion/README/provenance corrected.

**Named future work (not attempted) — superseded framing.** The earlier "quality-gated
canonical updates" idea assumed the loop must stabilise itself autonomously. A fuller design
pass reframed it: this is a **human-in-the-loop cognitive prosthesis, approaching not
guaranteeing** a result. The restoring force is a **per-lesson trust signal**, written
automatically **within the two-actor (user + system) loop, no third-party verifier**:
ground = the **objective execution outcome** of acting on the lesson (did the scope that
recalled it converge/succeed — reality is the judge, NOT the model self-grading), reinforced
by the user's natural behaviour, overridable by an explicit user edit (highest authority).
The crystallizing LLM is barred from scoring its own lesson (the D1 Proxy-Signal discipline).
Open research = de-confound the correlational outcome→lesson attribution (production has no
per-task A/B; a lesson recalled mostly for easy scopes looks accurate spuriously). Three
external sources (Anthropic long-running-harness, mindstudio + Osmani loop-engineering)
independently converge on human-in-the-loop + "don't let the model grade its own homework".
Captured in paper §5.7 + memory `next-direction-lesson-trust-substrate`.

---

## Freshness-substrate design discuss (2026-06-17, fuller + zoom-out) — NOT YET BUILT

Two fuller sessions + a schema-grounded discuss locked the design of the loop's restoring
force. **No code written; this is the spec for the build arc.** Calibration constants are
deliberately deferred to the clean re-run (see list at the end) — per the benchmark's own
lesson, a non-deterministic loop's thresholds must be fit from data, not guessed.

### Frame (the load-bearing analogy + boundary)
- **Ingredient = crystallization; freshness = per-crystallization trust.** The system (graph
  + crystallizations + algorithms) **owns ingredient freshness, and only that.**
- **Cooking = the LLM composing crystallizations into a workflow. OUT OF SCOPE** — model
  judgment, uncontrollable, acceptably model-dependent. We do not standardize the recipe.
- ⟹ a scope's outcome = freshness × cooking is a **joint function with an unobserved,
  out-of-scope confounder (cooking)**. The system grades **ingredients, not meals.** This
  dissolves the §5 "loop can't self-stabilise" problem: it was never responsible for the meal.
- **Teleology / KPI**: correct cooking + this system ⟹ good food; stronger, even the
  **simplest (token-efficient) cooking** succeeds. A great ingredient lets minimal cooking
  win. KPI = minimize tokens-to-good-outcome by raising ingredient quality (clean, not
  cooking-confounded).
- **Human spans both timescales** = monitor (witnesses growth) + verifier (checks key steps)
  + teacher (corrects drift → feeds the trust signal). Human input is **natural behaviour
  (accept/correct/approve/deny), never a typed number.**

### Schema reality (the rails are laid; the wiring is blind)
The freshness number recall actually reads = `quality_score = (success_count+1)/
(success_count+failure_count+1)` (Laplace), weight 0.3 in the procedural three-signal rerank
(`reflect.function.ts:240`). Both write paths already exist but are **blind**, and the
`confidence` column (Ebbinghaus, monotonic-up, lesson-fingerprint path) is a parallel
representation recall does NOT read — leave it alone (retire later).

| Mechanism | Today | Decision |
|---|---|---|
| harden | `reinforceTemplate` success_count+1, blind (all injected) | → conformance-gated/per-template + token-efficiency-graded |
| soften | `penalizeInjectedTemplates` failure_count+1, **OOM-only + blind** | **§P1: conformance-gated/per-template, trigger generalized** |
| metabolism | `markSupersededByEbbinghaus` time-only (90d unused) | **§P2: keep time-decay (atrophy) + ADD evidence-floor (apoptosis)** |
| mid-flight | (essentially absent) | **§P3: escalation gate beside `memReflect` in `process-agent-turn`** |

### Resolved parameters (the three decisions)

**P1 — soften path = conformance-gated / per-template.** Generalize
`penalizeInjectedTemplates` from "OOM-only, all-injected" to: for each injected template,
compare its prescribed ordering rules (`template_graph` / readable "X before Y") against the
actual scope event DAG. **Conformed + failed → `failure_count+1` (ingredient's fault).
Violated + failed → no change (cooking's fault, out of scope).** Token-efficiency grading
attaches to the symmetric harden side (conformed + token-efficient success → stronger credit).
This is the **automatic de-confounder** — the real advance on the paper's stated open problem;
the judge is a **deterministic DAG-vs-rules comparator, NOT a second LLM** (stronger than the
"second nice model" the loop-engineering sources propose; aligns with Anthropic "external
verification").

**P2 — metabolism floor = evidence-gated, THREE bands (C′).** Stays on the cron sweep
(`MemorySynthesizerWorker`), via logical-delete (`superseded_by=id`, reversible by human
override). Two distinct causes coexist: **atrophy** (existing 90d-unused time-decay) and
**apoptosis** (new, failure-evidence-driven). The apoptosis rule is three-band, not binary
(Osmani triage-inbox forced this):
- strong evidence bad → metabolize;
- strong evidence good → keep/harden;
- **ambiguous middle (thin/conflicting evidence) → surface to the human (triage), with the
  crystallization's success-rate shown — never silently decide.** The grey zone IS the human
  teaching surface; the human's accept/correct flows back as clean (human-localized)
  attribution. Metabolism must be **observable** (success rates exposed), not a silent cron.

**P3 — mid-flight escalation = same evidence signal, second read-time (no new threshold).**
Beside `memReflect` in `process-agent-turn`. **Proceed silently only when the plan rests on
confidently-good ingredients (high quality_score + sufficient evidence); otherwise (shaky OR
unproven) report the key steps for verification.** "Key step" = the prescribed "X before Y"
rules of the non-confident injected template (exactly the future conformance-check points) —
**sparse, only the learned-but-shaky constraints**, each shown with its success-rate. The
human's approve/correct at the checkpoint writes back to that template's success/failure
(clean attribution). `memReflect` must additionally return per-injected-template quality_score
+ evidence volume (today it returns only `proceduralIds`).

### The whole collapses to ONE substrate
`quality_score` + evidence volume (one signal) · `template_injection` (one provenance table) ·
one adaptive evidence boundary **read at two times** (before-act = P3 gate; after-close = P1
attribution feeding P2 metabolism). No scattered magic numbers.

### Research grounding (honest, with the dis-confirmation)
Three sources fetched (Anthropic harness; Osmani + mindstudio loop-engineering). **All three
are SILENT on statistical reliability scoring** — the only industry retirement analog is a
FIXED count ("after 10 iterations with no progress, escalate"). So **(C′)'s statistical shape
is NOT backed by these sources**; it rests on *our* benchmark's lesson (non-deterministic loop
→ statistical gate). What they DO converge on, and what was absorbed: reality/external as
judge not self-grading (Anthropic); split writer from checker (Osmani); unresolved → human
triage inbox (Osmani — this added the third band); "a loop running unattended is a loop
making mistakes unattended" (Osmani — backs observable metabolism + mid-flight gate).

### Calibration constants — fit from the clean re-run, do NOT hardcode now
1. **P2 apoptosis bands**: the `n_min` evidence volume (success+failure) below which evidence
   is "thin" → triage not retire; the quality_score lower/upper bounds delimiting bad / good /
   ambiguous. (Laplace already gives volume-sensitivity for free.)
2. **P1 grading**: the magnitude of `success_count`/`failure_count` increments — esp. the
   token-efficiency grading of conformant success (fractional vs +1), and whether a clean
   conformant-failure increments by >1 to realize "slow harden / fast soften."
3. **P3 gate**: the "confidently-good" boundary (reuses P2's good-band; confirm one boundary
   serves both read-times or they must differ).
4. **Conformance tolerance**: how strictly the actual DAG must match a prescribed "X before Y"
   to count as "conformed" (exact vs partial order).

### Build surface (from the zoom-out map) — for the eventual plan
`template-injection.ts` (P1 penalize rewrite + conformance check) · `template-proposal.worker.ts`
(harden grading) · `memory-repository.ts` (P2 metabolism query, P3 quality_score read) ·
`synthesizer.worker.ts` (P2 cron + triage emit) · `reflect.function.ts` (return quality_score
+ evidence) · `process-agent-turn.ts` (P3 gate + human-attribution writeback) · a human
triage/edit surface (today `/memory` is read-only). **Loop-regression-gate (`npm run
eval:loop`) before any change here, per CLAUDE.md.** Sequence: build → clean DB → re-run the
18-step curve as the **falsification test** that also fits the calibration constants.

## Freshness-substrate BUILD ARC execution (2026-06-17, autonomous /goal) — IN PROGRESS

Executing the spec above (#30–#35). Decision frame (chosen for project-as-whole, ≥mid
confidence, grounded in the benchmark's own §5.7 lesson): build every mechanism with
**config-externalized constants** (`freshness-config.ts`, env-overridable) defaulted to
**safe / behaviour-preserving** values; gate loop-asset changes with `npm run eval:loop`;
defer exact-constant CALIBRATION to the clean re-run (#35), which the spec itself marks HITL.

**Key schema finding driving the design.** The stored `template_graph` labels nodes by
event_type only (every procedural run is a uniform `task_spawned` chain), so topology cannot
judge step order. The step-order knowledge lives in the readable lesson prose ("X before Y",
emitted verbatim by the crystallization/golden prompts), and the actual step order lives in
`task_spawned` payload `.step`. So the conformance judge parses prose rules with a strict
deterministic scan grounded in the vocabulary the ACTUAL DAG provides — fully deterministic,
NOT a second LLM (stronger than the sources' "second nice model"; aligns with Anthropic
external-verification).

**Inertness boundary (important).** The eval harness (`scripts/eval/faithful-ab/agent.ts`)
calls `memReflect` directly and NEVER writes `template_injection` rows, so its curve learns
purely via crystallization + consolidation (`findMergeableTemplate` merge). Therefore the
soften (#30) and graded-harden (#31) paths — both keyed on `template_injection` — are inert
in the current curve and LIVE in production (`processAgentTurn` records injections + penalizes
on OOM; `onScopeClosed` step 6 hardens). This is why the freshness changes are additive /
behaviour-preserving for `eval:loop` (no regression) while being real in production. The #35
falsification will wire injection-recording into the harness to exercise the substrate and fit
the constants — deferred (live HITL), defaults set provisionally in `freshness-config.ts`.

### #30 conformance comparator + per-template soften — DONE (unit-tested, typecheck clean)
- NEW `conformance.ts`: `extractStepOrder` (task_spawned payload `.step`), `parseOrderingRules`
  ("X before Y" + "a -> b -> c" chains, vocab-grounded), `checkConformance`
  (conformed/violated/not-applicable; first-occurrence index; tolerance ratio). 11 tests.
- NEW `freshness-config.ts`: all calibration dials, env-overridable, safe defaults documented.
- `template-injection.ts` `penalizeInjectedTemplates` rewritten: per-template,
  conformance-gated (conformed+failed → `failure_count += softenIncrement`; violated /
  not-applicable / unparseable → untouched = fail-closed), trigger-generalized (works at any
  non-convergent terminal; production's only one today is OOM, caller unchanged). 5 tests.

### #31 token-efficiency-graded conformant harden — DONE (unit-tested, tsc clean)
- Repo: added `getInjectedTemplates(scopeId)` (id+content join) and a graded
  `reinforceTemplate(id, credit?)` (success_count += round(credit), default 1).
- Crystallizer step 6 rewritten: credits ONLY conformant injected templates
  (reuses the comparator), graded by events-to-converge via
  `gradeHardenCredit` (config; disabled by default → +1 until #35 fits the band).
  Violated / not-applicable → no credit (fail-closed, symmetric to soften).
- success_count is INT; fractional grading deferred to #35 (would need a column
  type change — a calibration decision, noted, not pre-empted).

### #32 evidence-gated three-band metabolism — DONE (unit-tested, tsc clean)
- Repo: `metabolizeByEvidence({nMin,qualityBad})` apoptosis (strong-bad →
  superseded_by=id, RETURNING evidence so it's observable); `getMetabolismTriage`
  (the ambiguous middle: live, used, neither proven-good nor -bad, with
  success-rate, for #34); `reinstateTemplate` (human override — only un-supersedes
  SELF-superseded rows, so consolidation merges are never resurrected).
- Synthesizer `runDecay` now runs atrophy (90d) AND apoptosis on the same cron
  sweep, logging each retirement (LOG_EVENTS.MEMORY_METABOLIZED). Ambiguous band
  is never auto-decided — surfaced to triage instead.
- Bands are config (n_min=5, bad≤0.3, good≥0.7 provisional); #35 fits them.

### #33 mid-flight escalation gate + memReflect quality return — DONE (unit-tested, tsc clean)
- memReflect now returns `proceduralStats: TemplateStat[]` (per-injected-template
  Laplace quality_score + evidence volume, for the templates that made the output).
  Both procedural SQL paths (hybrid + bm25-degraded) now SELECT success/failure_count.
- NEW `escalation.ts`: `selectShakyTemplates` (well-evidenced ≥ gateEvidenceFloor
  yet quality < gateQualityFloor) + `formatVerificationReport` (sparse — only the
  shaky template's "before"/"->" constraint lines + success-rate). 7 tests.
- `AssembledContext.verificationReport?` added; `processAgentTurn` sets it after
  reflection when the plan rests on shaky ingredients. Defensive `?? []` at the
  call site — an absent stat list never crashes a turn.
- DEFAULT POLICY (calibration-deferred): unproven (thin-evidence) templates stay
  silent so a freshly seeded cold start never escalates spuriously (satisfies the
  AC). #35 may lower the evidence floor.
- DB was down at suite time (only github-mcp-server container ran); brought up
  pgvector/pgvector:pg16 via `docker compose --env-file /dev/null up -d` (the .env
  has a malformed Slack-token line that breaks compose's env parser) + migrated
  graph + graph_test. Full workers+gateway suite: 415/415 green.

### #34 human triage/edit surface (write-half of /memory) — DONE (tsc clean, route + console tests green)
- Gateway `memory.ts` route gains the write-half: `GET /memory/triage` (ambiguous
  candidates + success-rate, bands from FRESHNESS), `POST /memory/templates/:id/feedback`
  {outcome:success|failure} (accept/correct → clean attribution, no numeric entry),
  `POST .../retire` (reversible logical-delete), `POST .../reinstate` (human override,
  self-superseded only). 6 new route tests (13 total in file).
- Console: NEW `/review` page (ui-ux-pro-max guidance applied — success-rate leads
  each card as tabular figure + bar; one primary CTA Keep; Needs work secondary;
  Retire danger-toned + spatially separated + inline confirm since the delete is
  reversible; optimistic removal with restore-on-error; empty/loading/error states
  mirror Emergence; aria-labels on every action; text left-aligned). Nav + crumb
  entry added in Shell.tsx. api.ts gains triage/triageFeedback/triageRetire/
  triageReinstate + postJson helper + TriageCandidate type.
- The skill's Quick Reference (loaded in-context) supplied the rules; its CLI
  symlink doesn't resolve on Windows, so the design intelligence came from the
  loaded guidance, not a fresh search.
- Console tsc clean; gateway 228/228 green.

### #35 falsification gate + verification — RESULT (no regression; calibration deferred)
**Build of #30–#34 is complete, committed, and verified** at the logic level:
workers+gateway 415/415 · full suite 832/832 (one parallel-DB deadlock flake,
passes isolated) · console tsc + `next build` green (`/review` in route manifest)
· live triage write-half journey 7/7 on the dev DB.

**`npm run eval:loop` (behavioral gate) FAILED in absolute terms**, BUT the failure
is NOT a regression from this change. Evidence:
- Branch curve (gpt-oss-120b): `48,121,121,121,121,121,121,121,121,121` — run #1
  converges, then collapses (the documented L2 bimodal failure: a messy run-#1
  trace crystallizes a misleading runbook that every later run recalls).
- SAME-SESSION baseline (master, none of these changes): `48,121,...` — IDENTICAL
  signature. master collapses the same way.
- In-repo prior curve JSONs on the same model already show baseline collapses
  (`46,121,106,121…`, `42,40,40,42,54,118,121,121,121,121`) alongside good holds
  (`26×`, `42→38`, `46→40`) — the curve is bimodal on this model (paper §5.7).
- **Code-path proof of inertness on the curve harness**: the eval agent calls
  `memReflect` directly and never writes `template_injection`, so soften is never
  called and graded-harden step-6 sees `getInjectedTemplates → []` (identical to
  master's `getInjectedTemplateIds → []` no-op); the metabolism cron isn't run.
  The `reflect.function.ts` edit only ADDED columns to the SELECT — `final_score`,
  `ORDER BY`, `formatProcedural`, and `proceduralIds` are unchanged, so the recall
  content the agent sees is byte-identical to master. ⟹ the freshness changes
  cannot have caused the collapse.

**Gate-design finding** (worth a follow-up): a single 10-run curve is ~one
Bernoulli trial of "did run-#1 crystallize a good runbook"; on a bimodal model the
absolute last-3 threshold cannot separate a bad draw from a regression. The gate
needs either a pinned validated model or a multi-sample collapse-RATE criterion.

**#35 constant calibration (the 4 deferred classes) remains HITL/deferred** — the
spec marked it so, and it requires wiring injection-recording into the harness +
deliberate multi-run fitting. All dials are externalized in `freshness-config.ts`
with safe behaviour-preserving defaults, so calibration needs no code change.

**Disposition**: branch `feat/freshness-substrate` is build-complete and
regression-free (proven), NOT merged to master (gate red on a model-bimodality
basis, and #35 calibration pending — a human merge decision).

## Post-arc direction — "prove the loop" research sprint (2026-06-17, fuller + research)
Autonomous decision (/goal authority supplies the priority dimension): near-term is
SINGLE-THREADED on proving the learning loop is falsifiably stable; the product arc
(MemexTerminal X-beam #25, console trail-mesh) waits until the loop is proven.

**Research grounding (validates the direction):**
- The bimodal collapse we hit is the literature's "error avalanche" / model collapse /
  "curse of recursion"; reflective memory's central risk is "self-reinforcing error"
  (arXiv 2601.05280; 2603.07670). Our run#1-bad-runbook→recalled→amplified IS this.
- The field's emerging cure = evidence-gated ACQUISITION: Live-Evo commits an experience
  only if it yields statistically significant improvement (arXiv 2602.02369). = our N5
  evidence-gated canonical promotion → promoted from "conditional" to "expected-needed".
- Quality gates (confidence/contradiction/expiry) are "necessary but underdeveloped";
  SSGM governance framework (arXiv 2603.11768). Our 3-band metabolism + Review fit here.
  Our deterministic conformance de-confounder (DAG-vs-rules, NOT a 2nd LLM) appears NOVEL
  vs the literature's success/fail signals + LLM-judge — a potential contribution.
- Statistical eval: single-seed is "highly unstable"; need multi-sample/variance
  (arXiv 2504.07086; ICLR-2026 non-determinism blog). Backs N1/N2.

**Plan (dependency order):**
- N1 DONE — loop-gate.ts → statistical multi-curve COLLAPSE-RATE + model pin
  (EVAL_LOOP_CURVES/RUNS/COLLAPSE_EVENTS/MAX_COLLAPSE_RATE/MODEL_PIN). Backward-compat
  at CURVES=1.
- N2 — measure baseline collapse-rate (current loop is inert-on-curve = baseline) to
  calibrate MAX_COLLAPSE_RATE (the null to beat).
- N3 — wire substrate into the eval closed loop (harness records template_injection +
  softens on non-convergent terminal) so soften/harden/metabolism actually fire.
- N4 — falsify substrate: branch vs baseline collapse-rate. cure-first (substrate built +
  conformance de-confounder is our novel angle); if insufficient → N5.
- N5 — prevention: evidence-gated canonical promotion (≥k consistent before full-weight
  recall) — directly attacks run#1 single point; research says likely needed.
- N6 — calibrate the 4 deferred constant classes (original #35) now that the gate is statistical.

**Mid-term (gated on loop proof):** M1 MemexTerminal X-beam (the #33 verificationReport +
 #34 /review ARE the approval surface — research line pre-builds product geometry), M2
console trail-mesh, M3 Review graduation (flying + resting timescales in one HITL surface).

### N2 RESULT — baseline collapse-rate ≈ 0.55 (measured from existing data, no new compute)
Across 11 in-repo §5 curves on gpt-oss-120b: 5 held (24-43 band), 6 collapsed
(last-3 mean > 80) → **baseline collapse-rate ≈ 0.55**. The validated "38/0 holds"
runs were the lucky ~45%. So the loop is barely-better-than-coinflip at baseline on
this model — this is the null the substrate (N3/N4) must beat. Gate bar set to 0.34
(≈ halve baseline). A clean same-config N2 run would tighten the estimate but the
direction is unambiguous. N1✓ N2✓(from data). NEXT: N3 (wire substrate into the eval
closed loop — code only) then N4 (measure collapse-rate with substrate, target ≪ 0.55).

### N4 RESULT — substrate FALSIFICATION PASSED (cure validated, ≥mid confidence)
Ran the substrate-wired loop (EVAL_LOOP_SUBSTRATE=1, n_min=2, 3 curves × 8 runs,
model-pinned gpt-oss-120b):
- collapse-rate **0.33** (1/3) vs **baseline ~0.55** → substrate roughly halves it; gate PASS.
- **Mechanism proven live (curve 2)**: run#1 crystallize → run#2-5 collapse (recall bad
  runbook) → **run#6 apoptosis retires it (metabolized=1, live_templates→0)** → run#7 cold
  re-converge (42) → run#8 recall new good runbook (44). The loop ESCAPED the collapse
  attractor via the substrate — the first live demonstration of the restoring force.
- curve 3: clean "越用越聪明" to the optimum (48→38→38→38…hold).
- **Residual mode (curve 1, NEW finding)**: "late drift" — a 6-success template fails at
  run#7-8 but cumulative Laplace quality (0.78) masks it → apoptosis doesn't fire. Cumulative
  quality is insensitive to recent degradation. This is what N5 must address.

**Conclusion**: the freshness substrate (cure) MATERIALLY works and the mechanism is
empirically demonstrated — the direction is validated with DATA, not just reasoning. n=3 is
suggestive on the aggregate; the live mechanism evidence is decisive. Tighter stats (more
curves) + late-drift fix are N5/N6.

### N5/N6 — data-motivated next steps (designed, not yet built)
- **N5 (recency-aware retirement)**: cumulative Laplace can't catch late drift. Add a
  recency signal — simplest: a consecutive-failure circuit breaker (k conformed-failures in
  a row → retire regardless of cumulative quality), or a windowed/decayed quality. Needs a
  small state field (recent-outcome streak) — schema decision. This is the Live-Evo
  "re-validate, don't trust forever" idea (prevention) applied to retirement.
- **N6 (calibration + stats)**: run ≥5 curves per arm for a tight collapse-rate CI; sweep
  n_min / qualityBad / soften-increment; fit the 4 deferred constant classes; pin the model.

### N5/N6 — research-validated design (2026-06-18, multi-source web research)
Reframed: a crystallization's reliability is a NON-STATIONARY Bernoulli process; late
drift = concept drift. Three independent literatures converge:
- Non-stationary bandits: D-UCB / SW-UCB (discount past, weight recent) match the
  non-stationary lower bound up to a log factor → simple discounting is near-optimal
  (Garivier & Moulines arXiv 0805.3415). ⟹ no need for heavy change-point machinery.
- Concept-drift detectors: ADWIN / Page-Hinkley (sustained gradual) / CUSUM — the
  formal "circuit breaker", kept as a fallback only.
- Agent-memory staleness is a NAMED open problem: high-relevance memories go
  "confidently wrong"; recency + retrieval-frequency are "simple but powerful"
  forgetting signals (arXiv 2603.07670; mem0 State-of-Memory-2026).
- Stat power (N6): detecting a 2% gain at 80% power needs ~9 runs, 95% needs ~15;
  single-run flips rankings in 83% of cases (arXiv 2602.07150). Our N4 n=3 is
  underpowered for the AGGREGATE claim (the live mechanism evidence is the strong part).

**N5 decision (4/4 confidence dimensions): recency-weighted quality (D-UCB-lite).**
Add `procedural_memory.recent_quality` (EWMA float, same mutable-counter family as
success_count/failure_count — does NOT touch the append-only event graph). Update on
each harden/soften: recent_quality = (1-α)*recent_quality + α*outcome (outcome 1/0).
Metabolism + mid-flight gate read recent_quality (with an evidence floor) instead of /
alongside cumulative Laplace → late drift sinks recent_quality fast → retire. Chosen
over ADWIN/Page-Hinkley because discounting is near-optimal AND honours the §5.7
"don't over-build loop assets" discipline. α is a deferred constant (N6).
**N6**: ~10 curves/arm powered collapse-rate CI + sweep α / bands / n_min (hours of
compute — a deliberate campaign, not inline).
