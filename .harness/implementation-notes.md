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
