# Phase 4 Context — External Integrations

**Phase goal:** MCP adapter (Claude Code native) + Pi SDK integration (Pi Terminal / Pi Sandbox rehearsal) + distributed lock (ConflictResolverWorker) + connect CLI

**Status:** Gray areas resolved, spikes validated. Ready for planning.

---

## 1. DRY Gaps — iii-config.yaml Full Alignment

**Decision: Full alignment with agentmemory iii-config (8 plugins)**

Current `iii-config.yaml` is missing 4 plugins required for durable subscriptions:

| Plugin | Config | Why |
|--------|--------|-----|
| `iii-queue` | `adapter: builtin` | Required for `durable:subscriber` — without it, topic subscriptions lost on restart |
| `iii-pubsub` | `adapter: local` | Required for `durable:subscriber` — same reason |
| `iii-state` | `adapter: kv, path: .iii-state` | Persistent KV for trigger registration |
| `iii-exec` | `watch: src/**/*.ts` | Auto-restart Workers on code change (dev DX) |
| `iii-observability` | `sampling_ratio: 0.1` | **CRITICAL**: agentmemory ADR issue #519 — full sampling (1.0) caused 137 GB log feedback loop |

**Impact:** `FRONTIER_TRIGGER_CONFIG = { type: 'durable:subscriber' }` is NOT actually durable today. Adding iii-queue + iii-pubsub fixes this.

---

## 2. Real-time Crystallization — Parallel Trigger Chain

**Decision: Parallel — new iii-sdk trigger chain coexists with batch MemorySynthesizer**

New chain (mirrors agentmemory's `crystallize → lesson-save`):
```
scope_closed event
  → sdk.trigger('graph::memory::crystallize', { actionIds })
    → LLM digest → Crystal
      → sdk.trigger('graph::memory::lesson-save', { content, confidence: 0.6 })
        → fingerprintId dedup → if existing: reinforceLesson (confidence += 0.1*(1-c))
                              → if new: create with confidence=0.5, decayRate=0.05
```

Batch `MemorySynthesizer` (2AM cron / ≥20 episodic) is kept — both paths coexist.

**fingerprintId:** `sha256(content)` — same content across sessions reinforces the same lesson.

---

## 3. Connect CLI — new `packages/cli` package

**Decision: New `packages/cli` package with `graph-runtime` bin**

### Structure

```
packages/cli/
  src/
    connect/
      claude-code.ts    ← write ~/.claude.json mcpServers entry
      pi.ts             ← write ~/.pi/agent/extensions/graph-runtime/
      util.ts           ← readJsonSafe, writeJsonAtomic, backupIfExists
    index.ts            ← CLI entrypoint (@clack/prompts)
  package.json          ← bin: { "graph-runtime": "./src/index.ts" }
```

### MCP block (Claude Code entry)

```json
{
  "mcpServers": {
    "graph-runtime": {
      "type": "http",
      "url": "${GRAPH_RUNTIME_URL:-http://localhost:4000}/mcp"
    }
  }
}
```

`GRAPH_RUNTIME_SECRET` env var adds `Authorization: Bearer` header (pre-wired from day 1, opt-in via env).

### Pi entry

Copies `packages/pi-extension/` to `~/.pi/agent/extensions/graph-runtime/`, patches `~/.pi/agent/settings.json`:
```json
{ "extensions": ["~/.pi/agent/extensions/graph-runtime"] }
```

**Pattern:** backup-before-write + `writeJsonAtomic` (rename trick) + post-write verification + idempotent check.
**UX:** `@clack/prompts` for interactive prompts.

---

## 4. Distributed Lock — ConflictResolverWorker

**Decision: `pg_try_advisory_lock` (non-blocking skip)**

Replace `Map<string, boolean>` with:
```sql
SELECT pg_try_advisory_lock(hashtext($1)::bigint)
```

- Returns `false` if lock already held → skip (same semantics as current Map)
- Non-blocking — never waits, never deadlocks
- Distributed — works across multiple Node.js processes
- OCC philosophy preserved — causal-chain deadlock from `pg_advisory_lock` (blocking) is categorically rejected

**Lock key:** `hashtext(entityId)::bigint` — PostgreSQL's `hashtext()` is stable within a major version.

---

## 5. Pi Integration — Pi Terminal + Pi Sandbox + Connect CLI

**Decision: Pi = `@earendil-works/pi-coding-agent` (external AI coding agent, NOT our own component)**

Pi is a third-party minimal terminal coding harness by Earendil Inc. (`npm install -g @earendil-works/pi-coding-agent`). Users run `pi` to enter its TUI — analogous to Claude Code but with an open extension system. We build a Pi *extension* package that plugs into Pi's extension loader.

**Pi 不是 hermes，也不是我们最终目标：** Pi 是 Phase 4 的一个集成点（coding 场景），hermes 是整个项目的长远愿景（Phase 5+）。两者独立。

### 修正：Pi ExtensionAPI 真实接口（经 WebFetch 验证）

| ctx 类型 | 适用场景 | fork() 可用？ |
|---|---|---|
| `ExtensionContext` | 事件处理器（`pi.on()`） | ❌ 无 runtime 属性，无 fork() |
| `ExtensionCommandContext` | 命令处理器（`registerCommand` handler） | ✅ `ctx.fork(entryId)` 直接调用 |

**首选激活路径：** `session_before_fork` 事件 — 用户运行 Pi 内置 `/fork <entryId>` 时自动触发，无需自定义命令。

### Architecture

```
packages/pi-extension/          ← NEW (Phase 4)
  src/index.ts                  ← ExtensionAPI entry
  package.json                  ← { "pi": { "extensions": ["./src/index.ts"] } }

packages/shared/src/
  write-guard.ts                ← InMemoryShadowAdapter (spike 003)

packages/cli/src/connect/
  pi.ts                         ← connect-pi (spike 005)
```

### Pi Extension registers

| Tool/Command | Type | Behavior |
|---|---|---|
| `spawn_task` | Pi tool | Calls graph MCP, uses shadow proxy in rehearsal |
| `complete_task` | Pi tool | Calls graph MCP, uses shadow proxy in rehearsal |
| `session_before_fork` event | hook | Pi native `/fork` → activates `InMemoryShadowAdapter` |
| `/fork-ext <entryId>` | Pi command | `ctx.fork(entryId)` (ExtensionCommandContext) + shadow (explicit override path) |
| `/fork-end` | Pi command | `shadow.clear()` — 阅后即焚 |
| `tool_call` event | Guard hook | Blocks `rm`, `git push`, `git commit`, `psql` in rehearsal mode |

### InMemoryShadowAdapter (spike 003 validated)

```typescript
// Write interception: sql.trimStart().startsWith('WITH new_version AS')
// Both OCC_WRITE_SQL and OCC_WRITE_DO_NOTHING_SQL match this prefix
// Fake WriteResult: { occ_result: 'won', version_hash: 'shadow::...' }
// Reads: passthrough to real pool (reads always see true PostgreSQL state)
// Destroy: shadow.clear() — O(1), no DB cleanup
```

**NOTIFY isolation is FREE:** NOTIFY fires via PostgreSQL DB TRIGGER on `execution_event_log` INSERT. Shadow writes never reach PostgreSQL → trigger never fires → real Workers never see shadow events. No extra isolation code needed.

### Dual-track lifecycle

```
Interactive Mode:
  Pi → our extension tools → PostgresWriteAdapter → pool.query()
    → DB TRIGGER → NOTIFY graph_event_ready → real Workers

Rehearsal Mode (Pi native /fork <entryId> OR /fork-ext <entryId>):
  Pi → runtime.fork(entryId) → InMemoryShadowAdapter.proxy
    → Map<string, ShadowEntry[]>  (writes)
    → real pool                   (reads, passthrough)
    → [NO DB TRIGGER, NO NOTIFY, NO real Workers]
  /fork-end → shadow.clear() → activeShadow = null
```

---

## Phase 4 Scope

- **Single-user, multi-session** (multiple Claude Code / Pi processes sharing same graph)
- Distributed lock needed for multi-process conflict resolution
- NOT multi-user (no auth, no tenant isolation — that's a future phase)

---

## Spike Verdicts

| Spike | Validates | Result |
|---|---|---|
| 003 shadow-adapter | OCC write interception, SELECT passthrough, NOTIFY isolation | ✓ VALIDATED |
| 004 pi-extension | ExtensionAPI tool/command registration, /fork lifecycle | ✓ VALIDATED |
| 005 connect-pi | Atomic install to ~/.pi/agent/extensions/, idempotent settings patch | ✓ VALIDATED |

All spike code at `.planning/spikes/003–005/`. Commits `0d75edb` + `c91afdd`.

---

## Pi 与 hermes 的关系（架构定位）

| 维度 | Pi | hermes |
|---|---|---|
| 本质 | 第三方 coding agent terminal (Earendil Inc.) | 完整自我改进 AI agent (NousResearch) |
| 语言 | TypeScript | Python |
| 与我们的关系 | Phase 4 集成目标（build Pi extension） | 项目长远愿景（我们最终想达到的样子） |
| 时间线 | Phase 4 | Phase 5+ |
| 集成方式 | 我们提供 Pi extension，Pi 加载它 | 我们的图可成为 hermes MemoryManager 的 external provider |
| 覆盖场景 | 编程工作流（coding-focused） | 通用 AI agent（multi-platform, self-improving） |

**hermes 是愿景，Pi 是工具。** hermes 有 `MemoryManager`（one external plugin provider at a time），未来我们的执行图可以作为其记忆后端。但 Phase 4 不集成 hermes — Phase 4 只集成 Pi 和 Claude Code (MCP)。

---

## Files Not to Touch in Phase 4

- `packages/shared/src/occ-write.ts` — write path is correct, shadow adapter decorates it
- `packages/workers/src/patterns/` — Phase 5+ territory
- `packages/gateway/src/routes/mcp.ts` — existing MCP tools stay as-is
