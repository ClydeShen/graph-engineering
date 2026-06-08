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
| Control Plane OOM status=terminated bug | `docs/未决问题追踪.md` §P0-E (Phase 2 必修) |
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
