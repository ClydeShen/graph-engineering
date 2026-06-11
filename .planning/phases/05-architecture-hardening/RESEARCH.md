# Research: Phase 5 — Architecture Hardening

> Generated from manual analysis of two specimen projects:
> - `D:\Repo\specimens\nanobot` — early prototype (Python, 618 files)
> - `D:\Repo\specimens\hermes-agent` — second-gen Memex analog (Python+TS, mature)

---

## ARCH-01 — FallbackProvider (circuit-breaker)

### Pattern found: hermes-agent `agent/error_classifier.py`

**Key design**: Standalone `classify_api_error(error) → ClassifiedError` function. Error classification is separated from retry execution.

```python
@dataclass
class ClassifiedError:
    reason: FailoverReason      # enum: auth, rate_limit, overloaded, context_overflow, ...
    retryable: bool
    should_fallback: bool       # → switch to backup provider
    should_compress: bool       # → reduce context, not failover
    should_rotate_credential: bool
```

**FailoverReason taxonomy** (priority-ordered classification pipeline):
1. Content-policy blocked (content_filter) → `retryable=False, should_fallback=True`
2. Auth/401/403 → `retryable=False, should_fallback=True`
3. Billing/402 → `retryable=False, should_rotate_credential=True, should_fallback=True`
4. Rate-limit/429 → `retryable=True, should_fallback=True`
5. Overloaded/503 → `retryable=True`
6. Context overflow/400+large → `retryable=True, should_compress=True` (NOT failover)
7. Timeout/transport → `retryable=True`

**Mapping to ARCH-01 spec**:
| Our spec | hermes FailoverReason |
|---|---|
| timeout → failover | `timeout` → retry on same + failover after N |
| rate_limit → failover | `rate_limit` → `should_fallback=True` |
| overloaded → failover | `overloaded` → retry, then failover |
| auth → direct throw | `auth` → `retryable=False`, no fallback in our case |
| context_length → direct throw | `context_overflow` → `should_compress=True`, no fallback in our case |
| content_filter → direct throw | `content_policy_blocked` → `retryable=False` |

**DRY action**: Port `FailoverReason` as TypeScript enum + `classifyProviderError()` function.
Adapt `should_fallback` logic to match our decision (auth/context/content_filter = throw, not fallback).

### Pattern found: nanobot `providers/base.py`

- Error retry EMBEDDED in base class `_run_with_retry()` — avoid this coupling
- Good source for retry delay constants: `_CHAT_RETRY_DELAYS = (1, 2, 4)` seconds
- `_is_transient_response()` / `is_arrearage_response()` — secondary reference for edge cases

**FallbackProvider TypeScript sketch**:
```typescript
interface ProviderConfig { name: string; provider: LLMProvider; priority: number }
class FallbackProvider implements LLMProvider {
  chat(messages, opts) {
    for (const p of this.providers) {
      const result = await p.provider.chat(messages, opts).catch(classifyProviderError)
      if (result.shouldThrow) throw result.error  // auth/context/content_filter
      if (result.ok) return result.response
      if (result.shouldFailover) continue          // try next provider
    }
    throw new AllProvidersExhaustedError()
  }
}
```

---

## ARCH-02 — WebSocket/SSE real-time stream

### Pattern found: hermes-agent `agent/transports/`

Transport layer is **separate from channel/provider** — abstracts the wire protocol.

Files: `base.py`, `anthropic.py`, `chat_completions.py`, `bedrock.py`, `codex.py`

Key insight: SSE streaming is a **transport concern**, not a provider concern. The transport:
- Reads chunked SSE frames
- Calls `on_content_delta(chunk)` callback per frame  
- Returns final `LLMResponse` after stream ends

**Our ARCH-02 design**:
- Gateway `GET /v1/stream` → SSE endpoint (text/event-stream)
- Event format: `data: {"type":"trail_event","event_type":"task_spawned","payload":{...}}\n\n`
- Uses `pg_notify` → node `pg.client.on('notification')` → `res.write()`
- MemexTerminal subscribes once, receives live trail events

nanobot `channels/websocket.py` is channel-layer (user-facing) — not directly reusable for our pg_notify→SSE bridge.

**Implementation pattern** (Hono SSE):
```typescript
app.get('/v1/stream', (c) => {
  return streamSSE(c, async (stream) => {
    const client = await pool.connect()
    await client.query('LISTEN trail_events')
    client.on('notification', (msg) => stream.writeSSE({ data: msg.payload }))
    await stream.sleep(/* keep-alive */)
  })
})
```

---

## ARCH-03 — `@graph/types` centralized package

### Pattern found: hermes-agent `providers/base.py` ProviderProfile

`ProviderProfile` is a **declarative dataclass** (not abstract class). Transport reads it.
This maps to our `@graph/types/core` — types are data shapes, not behavior.

### Extends @earendil-works/pi-coding-agent

Pi SDK exports: `TaskPayload`, `AgentCard`, `SkillDefinition`, `ScopeRef`.
Our `@graph/types` should:
- **Re-export** Pi SDK types (don't duplicate)
- **Extend** where our schema adds fields (e.g. `MemexTaskPayload extends TaskPayload`)
- **Three-layer split**:
  - `@graph/types/core` — graph engine types (Entity, Snapshot, HyperEdge, Scope, Trail)
  - `@graph/types/api` — HTTP/MCP wire types (request/response shapes)
  - `@graph/types/shell` — MemexShell UI types (display, SSE event shapes)

---

## ARCH-04 — `~/.memex/config.json` global config

### Pattern found: hermes-agent `cli-config.yaml.example`

hermes-agent uses `~/.hermes/` home + `cli-config.yaml`. Provider registry structure:
```yaml
model:
  default: "anthropic/claude-opus-4.6"
  provider: "auto"  # or "anthropic", "openrouter", etc.
  api_key: "..."    # OR env var
  base_url: "..."
  fallback_models: [...]
```

### Pattern found: nanobot `config/schema.py`

`InlineFallbackConfig(model, provider, max_tokens, context_window_tokens)` as typed fallback candidate.
Pydantic `BaseSettings` with `AliasChoices` for camelCase/snake_case.

**Our `~/.memex/config.json` design**:
```json
{
  "gateway": { "port": 4000 },
  "providers": [
    {
      "name": "primary",
      "type": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}",
      "model": "claude-sonnet-4-6",
      "priority": 1
    },
    {
      "name": "fallback",
      "type": "ollama", 
      "baseUrl": "http://localhost:11434",
      "model": "llama3",
      "priority": 2
    }
  ],
  "channels": {
    "telegram": { "token": "${TELEGRAM_BOT_TOKEN}" }
  }
}
```

`${ENV_VAR}` resolution: scan string values, replace at load time. Validated by Zod schema.

**Important**: `~/.memex/config.json` = Gateway + providers. Worker side keeps `iii-config.yaml`.

---

## ARCH-05 — SKILL.md progressive loading

### Pattern found: hermes-agent `agent/skill_bundles.py`

Two-phase loading pattern:
1. **Phase 1 (directory scan)**: Read `_bundles_dir()`, parse filename + YAML frontmatter only → `{ name, description, path }`
2. **Phase 2 (on demand)**: Read full file content when `/skill-name` is invoked

Cache pattern:
```python
_bundles_cache: Dict[str, Dict[str, Any]] = {}
_bundles_cache_mtime: Optional[float] = None
# Invalidate when dir mtime changes
```

**Our two-phase design**:
- Phase 1 (list): Scan `skills/*/SKILL.md`, parse YAML frontmatter → return `{ fingerprintId, name, description }[]`
- Phase 2 (load): Read full body only when agent requests specific skill

Boundary: ≥10 skills → Phase 1 bundle is ≥50% smaller than loading all full bodies.

**Gateway endpoint change**:
- `GET /v1/skills` → returns Phase 1 list (name + description only)
- `GET /v1/skills/:id` → returns Phase 2 full body

---

## ARCH-06 — CrystallizeWorker surgical distillation

### Pattern found: hermes-agent `agent/curator.py`

**Curator** = background auxiliary-model task for skill maintenance.

Key invariants directly applicable to our CrystallizeWorker:
- **Never overwrites** — only appends/updates deltas
- **Inject existing content** → LLM produces minimal delta, not full rewrite
- Uses **auxiliary model** (separate from main session — doesn't pollute context)
- **Idempotent** — safe to re-run on same scope
- Pinnable (locked lessons skip auto-update)

**Crystallization delta prompt pattern**:
```
Existing lesson:
<existing_lesson_content>

New observations from this trail:
<raw_trail_events>

Output ONLY what changed or should be added. Do not repeat unchanged content.
```

### Pattern found: nanobot `agent/memory.py` (Dream consolidation)

- 2h interval memory consolidation
- Injects prior memory snapshot → outputs incremental additions
- Ebbinghaus `reinforcement_count` bump on re-encounter

**Our delta implementation**:
```typescript
// In CrystallizeWorker
const existing = await getExistingLesson(fingerprintId)
const prompt = existing
  ? `${DELTA_PROMPT}\n\nEXISTING:\n${existing.content}\n\nNEW TRAIL:\n${trailEvents}`
  : `${FULL_PROMPT}\n\nTRAIL:\n${trailEvents}`
const delta = await llm.chat(prompt)
await occWrite({ content: existing ? mergeDelta(existing, delta) : delta })
```

---

## Cross-cutting: DRY with Pi SDK and iii engine

**What to EXTEND (not duplicate)**:
- `@earendil-works/pi-coding-agent`: `TaskPayload`, `AgentCard`, `SkillDefinition` → extend in `@graph/types/core`
- iii engine `WorkerBase`, `ToolBase` → already imported; types stay in their package
- Gateway Hono app → add SSE route to existing structure

**What to CREATE new**:
- `packages/types/` — new package, peer of `packages/shared`
- `classifyProviderError()` — new function in `packages/shared/src/llm/`
- `FallbackProvider` — new class in `packages/shared/src/llm/`
- `~/.memex/config.json` loader — new file in `packages/shared/src/config/`
- `/v1/stream` SSE route — new route in `packages/gateway/src/routes/`
- SKILL.md two-phase loader — extend existing `packages/gateway/src/routes/skills.ts` (if exists) or create

**What NOT to change**:
- `packages/shared/src/occ-write.ts` — OCC append-only; do not touch
- `packages/shared/src/canonical-json.ts` — hash stability; do not touch
- DB schema — no DDL in Phase 5
- Existing worker event strings (`graph::*`) — grandfathered

---

## Risk flags

1. **ARCH-03 `@graph/types` package**: Adding a new `packages/types` creates a potential circular dependency if `packages/shared` imports from it. Keep `@graph/types` as a **leaf** (no imports from other packages).
2. **ARCH-04 config loader**: `~/.memex/config.json` is optional — system must boot without it (env vars fallback).
3. **ARCH-02 SSE**: Hono's `streamSSE` helper exists but needs the `@hono/node-server` adapter for Node.js response streaming. Verify adapter version.
4. **ARCH-05 mtime cache**: Windows file mtime resolution is 100ms — not 1ms. Cache invalidation logic must use `>` not `>=`.
