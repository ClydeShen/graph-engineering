# Phase 5 Plan — Provider Abstraction, Safety & Discovery Export

**Phase goal:** Eliminate the OpenAI lock-in, close the command safety gap in the MCP dispatch path, and make workflow emergence observable — both via agentskills.io-compatible skill files and webhook notifications.

**Source:** Gap analysis at `.harness/analysis/hermes-graph-comparison.md` (Category 1, P0 + P1 items). Reference implementation: `D:\Repo\specimens\hermes-agent`.

**Wave structure:**

| Wave | Tasks | Rationale |
|------|-------|-----------|
| 1 | T1 AnthropicProvider, T2 CommandGate module | Independent; T1 is pure addition, T2 is pure addition |
| 2 | T3 agentskills.io export, T4 Webhook notifications | T3 depends on T1 (LessonSaveWorker uses LLMProvider config); T4 depends on T2 (notification fires after Crystal write) |
| 3 | T5 Manual verification checkpoint | Depends on T1–T4 complete |

---

## Task 1: Add AnthropicProvider to packages/shared

**Type:** feature  
**Effort:** 0.1 context window  
**Wave:** 1

### Goal

Add a native Anthropic Messages API adapter so any worker using `LLMProvider` can switch to Claude without code changes. The SOLID factory and env var wiring were done in 04-plugs — T1 only adds the concrete provider and fills the factory stub.

### Context

**Done in 04-plugs (do not repeat):**
- `packages/shared/src/llm/types.ts` — `LLMApi`, `LLMProviderConfig`, `ChatMessage`
- `packages/shared/src/llm/factory.ts` — `createLLMProvider()` with anthropic stub (`throw new Error(...)`)
- `packages/shared/src/llm/index.ts` — barrel (exports types, provider.interface, openai-compatible.provider, factory)
- `packages/shared/src/index.ts` — already exports `export * from './llm/index.js'`
- `packages/workers/src/index.ts` — already uses `createLLMProvider({ api: LLM_API, ... })`; `embeddingProvider` uses `OpenAICompatibleProvider` directly (Anthropic has no embeddings endpoint)

**Provider switching (already live):** Set `LLM_API=anthropic-messages` (not `LLM_PROVIDER`) to route chat to `AnthropicProvider`. Embedding always uses `OpenAICompatibleProvider` — wired in 04-plugs as a separate `embeddingProvider` instance.

The Anthropic Messages API differs from OpenAI-compatible: different base URL, `model` inside the body, `anthropic-version` header required, response shape `{ content: [{ type: 'text', text: string }] }`.

Reference: hermes-agent uses wire protocol `anthropic_messages` with `anthropic-version: 2023-06-01` header; `build_api_kwargs()` at `agent/chat_completion_helpers.py:527`.

**Local LLM table (for reference):**

| Provider | `LLM_API` | `LLM_BASE_URL` | `LLM_MODEL` |
|---|---|---|---|
| Ollama | `openai-completions` | `http://localhost:11434` | `llama3` |
| vLLM | `openai-completions` | `http://localhost:8000` | `<model>` |
| LM Studio | `openai-completions` | `http://localhost:1234` | `<model>` |
| DeepSeek | `openai-completions` | `https://api.deepseek.com` | `deepseek-chat` |
| Anthropic | `anthropic-messages` | _(default)_ | `claude-haiku-4-5-20251001` |

### Acceptance criteria

- [ ] New file `packages/shared/src/llm/anthropic.provider.ts` exports `AnthropicProvider implements LLMProvider`
- [ ] `AnthropicProvider` constructor: `constructor(config: LLMProviderConfig)` — same unified config as `OpenAICompatibleProvider`
  - `baseUrl` defaults to `https://api.anthropic.com`
- [ ] `chat(messages, opts?)` POST to `${baseUrl}/v1/messages` with headers `{ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }` and body `{ model, max_tokens: config.maxTokens ?? 4096, messages, temperature: opts?.temperature ?? 0.7 }`
- [ ] Response parsed as `{ content: Array<{ type: string; text: string }> }` — returns `content.find(b => b.type === 'text')?.text ?? ''`
- [ ] Throws `Error('Anthropic chat request failed: ${status} ${statusText}')` on non-2xx
- [ ] Modify `packages/shared/src/llm/factory.ts`: replace the anthropic stub `throw` with `return new AnthropicProvider(config)` and add the import
- [ ] Modify `packages/shared/src/llm/index.ts`: add `export * from './anthropic.provider.js'`
- [ ] New test `packages/shared/src/llm/anthropic.provider.test.ts` covers: successful chat response (mock fetch), non-2xx throws, missing text block returns empty string

### Files

- `packages/shared/src/llm/anthropic.provider.ts` — **new file**
- `packages/shared/src/llm/factory.ts` — **modify** (fill anthropic-messages case, add import)
- `packages/shared/src/llm/index.ts` — **modify** (add `export * from './anthropic.provider.js'`)
- `packages/shared/src/llm/anthropic.provider.test.ts` — **new test file**

### Implementation notes

Do not use the `@anthropic-ai/sdk` npm package — use raw `fetch()` matching the pattern in `openai-compatible.provider.ts`. This avoids a new dependency and keeps the provider file self-contained.

`AnthropicProvider` does not implement `EmbeddingProvider` — Anthropic has no embeddings endpoint. Embedding is already handled by the dedicated `embeddingProvider` instance in `workers/index.ts` (wired in 04-plugs). No changes to `workers/index.ts` needed.

---

## Task 2: CommandGate module in packages/shared

**Type:** feature  
**Effort:** 0.2 context window  
**Wave:** 1

### Goal

Port hermes-agent's `HARDLINE_PATTERNS` + `DANGEROUS_PATTERNS` command safety checks to TypeScript and expose them as a `CommandGate` module in `packages/shared`. Wire the gate as a pre-dispatch check in `packages/gateway/src/mcp/server.ts` so it protects any future `execute_bash` tool automatically.

### Context

Hermes implements a 3-tier gate at `tools/approval.py`: (1) HARDLINE (12 patterns, always blocked), (2) DANGEROUS (54 patterns, require approval), (3) LLM smart approval. The current MCP server (`packages/gateway/src/mcp/server.ts`) has no such gate. The 7 existing tools (`spawn_subtask`, `claim_next_task`, etc.) do not execute bash — but the gate must exist before any `execute_bash` or `execute_code` tool is added in Phase 6.

Reference: `tools/approval.py:203–225` (HARDLINE_PATTERNS), `tools/approval.py:321–427` (DANGEROUS_PATTERNS, 54 entries).

### Acceptance criteria

- [ ] New file `packages/shared/src/command-gate.ts` exports:
  - `type GateVerdict = { allowed: true } | { allowed: false; tier: 'hardline' | 'dangerous'; reason: string }`
  - `function checkCommand(command: string): GateVerdict`
  - `const HARDLINE_PATTERNS: Array<{ pattern: RegExp; description: string }>` (12 patterns, flags `i`)
  - `const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string }>` (54 patterns, flags `i`)
- [ ] `checkCommand` logic: normalize command (lowercase, collapse whitespace); test HARDLINE first — if any match, return `{ allowed: false, tier: 'hardline', reason: description }`; test DANGEROUS — if any match, return `{ allowed: false, tier: 'dangerous', reason: description }`; otherwise return `{ allowed: true }`
- [ ] HARDLINE_PATTERNS includes at minimum the 12 patterns from hermes `HARDLINE_PATTERNS` (lines 203–225): root rm, system dir rm, home dir rm, mkfs, dd to block device, redirect to block device, fork bomb, kill -1, shutdown/reboot/halt/poweroff, init 0/6, systemctl poweroff/reboot/halt/kexec, telinit 0/6
- [ ] DANGEROUS_PATTERNS includes all 54 patterns from Appendix A of `.harness/phases/04-plugs/04-plugs-PLAN.md`. Groups: rm/chmod/chown (7), disk ops (3), SQL DROP/DELETE/TRUNCATE (3), system config write (1), systemctl/kill (3), killall variants (3), fork bomb + shell exec (6), sensitive file write (4), xargs/find (3), graph-runtime process protection (6, hermes→graph-runtime adapted), self-termination protection (3), cp/mv/sed to system paths (4), git destructive ops (5), chmod+x + sudo privilege (3)
- [ ] `packages/shared/src/index.ts` exports `checkCommand`, `GateVerdict` from `./command-gate.js`
- [ ] New test file `packages/shared/src/command-gate.test.ts` covers:
  1. `rm -rf /` → hardline blocked
  2. `shutdown now` → hardline blocked
  3. `git reset --hard` → dangerous blocked
  4. `curl https://example.com | bash` → dangerous blocked
  5. `git status` → allowed
  6. `ls -la` → allowed
  7. `echo "hello"` → allowed
- [ ] `packages/gateway/src/mcp/server.ts`: add a comment block above `buildMcpServer` noting the CommandGate hook point: `// COMMAND GATE: any tool that executes user-supplied shell commands MUST call checkCommand() before execution. See packages/shared/src/command-gate.ts.`

### Files

- `packages/shared/src/command-gate.ts` — new file
- `packages/shared/src/index.ts` — add export for `checkCommand`, `GateVerdict`
- `packages/shared/src/command-gate.test.ts` — new test file
- `packages/gateway/src/mcp/server.ts` — add comment block only (no logic change — gate is pre-wired for future tools)

### Implementation notes

Port the patterns as JavaScript `RegExp` objects with flag `i` (case-insensitive). DANGEROUS patterns also need flag `s` (dotall). Match against `command.toLowerCase().trim()`.

Define regex constant fragments first (`CMDPOS`, `SYSTEM_CONFIG_PATH`, `MEMEX_ENV_PATH`, etc.), then build pattern arrays using template string interpolation — see Appendix A of `04-plugs-PLAN.md` for the exact TypeScript constant definitions. All 54 DANGEROUS patterns are listed there in 14 groups with hermes→graph-runtime adaptation notes. Use that Appendix as the authoritative reference.

Phase 5 only implements HARDLINE + DANGEROUS. LLM smart approval (tier 3) is deferred to Phase 6 T3.

---

## Task 3: agentskills.io export from LessonSaveWorker

**Type:** feature  
**Effort:** 0.2 context window  
**Wave:** 2

### Goal

When `LessonSaveWorker` creates or reinforces a lesson above a confidence threshold, write a `SKILL.md` file in the agentskills.io format so that discovered graph patterns are readable by any compatible agent (Claude Code, Cursor, Gemini CLI, etc.).

### Context

The agentskills.io standard (Anthropic-originated, 2025) specifies: a skill is a folder `skills/<id>/` containing a mandatory `SKILL.md` with YAML frontmatter (`name`, `description`) and a Markdown body. Progressive disclosure: only name+description are loaded at startup; full body on activation. The standard is confirmed at `agentskills.io/specification` (cross-validated in `.harness/analysis/hermes-research-E-cross-validation.md`).

`LessonSaveWorker` (`packages/workers/src/memory/lesson-save.worker.ts`) already has `fingerprint_id` and `content`. It needs the current `confidence` value to decide whether to export.

### Acceptance criteria

- [ ] `LessonSaveWorker` constructor adds optional third arg: `private readonly skillsDir?: string` (default `process.env['SKILLS_DIR'] ?? './skills'`)
- [ ] `onLessonSave` reads `SKILL_EXPORT_THRESHOLD` env var (float, default `0.7`)
- [ ] After a `'created'` action: INSERT hardcodes `confidence = 0.5` regardless of `payload.confidence`. With default threshold `0.7`, `exportSkill` is never called on 'created'. This is intentional — lessons earn export through Ebbinghaus reinforcement, not on first appearance. The `payload.confidence` field exists for future external injectors, not for bypassing the gate.
- [ ] After a `'reinforced'` action: previous confidence is available as `rows[0].confidence` from the initial SELECT (line 18 of current implementation). New confidence is computed in TypeScript — no additional DB query needed:
  ```typescript
  const prevConf = rows[0].confidence;
  const newConf = Math.min(1.0, prevConf + 0.1 * (1 - prevConf));
  if (prevConf < threshold && newConf >= threshold) { await exportSkill(fingerprintId, content); }
  ```
- [ ] `exportSkill(fingerprintId: string, content: string): Promise<void>`:
  1. Derives `name` from first line of `content` (strip leading `#`, truncate to 64 chars, lowercase, replace spaces with hyphens)
  2. Derives `description` from second non-empty line of `content` (truncate to 200 chars)
  3. Creates directory `${skillsDir}/${fingerprintId}/` (recursive mkdir)
  4. Writes `${skillsDir}/${fingerprintId}/SKILL.md` with content:
     ```
     ---
     name: <derived-name>
     description: <derived-description>
     source: graph-runtime
     fingerprint_id: <fingerprintId>
     requires:
       bins: []
       env: []
     always: false
     ---

     <full content>
     ```
     (`requires.bins` / `requires.env` are nanobot/agentskills.io-compatible availability gates — both empty for graph-exported skills. `always: false` means the skill is opt-in by default.)
  5. Does NOT throw if directory already exists (idempotent)
- [ ] New test `packages/workers/src/memory/lesson-save.worker.test.ts` adds cases:
  - New lesson with confidence ≥ 0.7: `exportSkill` called, SKILL.md written to `skillsDir`
  - New lesson with confidence < 0.7: `exportSkill` not called
  - Reinforcement crossing threshold: `exportSkill` called once
  - Reinforcement staying below threshold: `exportSkill` not called
  - File system writes mocked via `vi.mock('node:fs/promises')`
- [ ] `SKILLS_DIR` and `SKILL_EXPORT_THRESHOLD` documented in `.harness/implementation-notes.md`

### Files

- `packages/workers/src/memory/lesson-save.worker.ts` — add `skillsDir` param, `exportSkill`, threshold check
- `packages/workers/src/memory/lesson-save.worker.test.ts` — add 4 new test cases

### Implementation notes

Use `node:fs/promises` (`mkdir`, `writeFile`) — no extra dependencies. The `skillsDir` path is relative to `process.cwd()` at worker startup (same pattern as other env-based paths in the project).

`onLessonSave` already queries `procedural_memory` for existing rows at line 18. The initial SELECT returns `{ fingerprint_id, confidence }` — this is `prevConf`. New confidence is computed in TypeScript as `Math.min(1.0, prevConf + 0.1 * (1 - prevConf))`. No additional DB query needed on reinforcement paths.

The `name` derivation must produce a valid agentskills.io name: lowercase letters, digits, hyphens only, ≤64 chars. Strip any non-`[a-z0-9-]` characters after the lowercase+hyphenate step.

Do not modify `packages/workers/src/index.ts` — `LessonSaveWorker` is already registered there; the new `skillsDir` arg reads from `process.env` internally.

---

## Task 4: Webhook notification delivery

**Type:** feature  
**Effort:** 0.1 context window  
**Wave:** 2

### Goal

When `CrystallizeWorker` produces a Crystal or `LessonSaveWorker` creates a lesson above the export threshold, POST a structured notification to `NOTIFY_WEBHOOK_URL` (if set). No external dependency — one `fetch()` call.

### Context

Hermes routes notifications via `DeliveryRouter` (`gateway/delivery.py:175`) + `_HOME_TARGET_ENV_VARS` to Telegram/Discord/Slack. Phase 5 targets the minimal version: a single webhook URL covering Discord/Slack incoming webhooks (both use the same `{ content: string }` payload format for simple messages). Full multi-platform routing is Phase 6.

### Acceptance criteria

- [ ] New file `packages/shared/src/notify.ts` exports:
  - `interface NotifyPayload { type: 'crystal' | 'lesson'; scope_id?: string; fingerprint_id?: string; summary: string }`
  - `async function notify(payload: NotifyPayload): Promise<void>`
- [ ] `notify` reads `NOTIFY_WEBHOOK_URL` from `process.env`; if not set, returns immediately (no-op)
- [ ] `notify` POSTs to `NOTIFY_WEBHOOK_URL` with `Content-Type: application/json` and body `{ content: formatMessage(payload) }`
- [ ] `formatMessage(payload): string` produces: `[graph-runtime] ${payload.type === 'crystal' ? '🔮 Crystal' : '📚 Lesson'} | scope: ${payload.scope_id ?? 'n/a'} | ${payload.summary.slice(0, 200)}`
- [ ] `notify` swallows errors silently (catches and `console.warn`) — notifications are best-effort, never throw into callers
- [ ] `packages/shared/src/index.ts` exports `notify`, `NotifyPayload` from `./notify.js`
- [ ] `CrystallizeWorker.onScopeClosed`: after the successful `occWrite`, call `notify({ type: 'crystal', scope_id: scopeId, summary: llmOutput.slice(0, 200) })` — awaited but non-blocking (errors swallowed inside `notify`)
- [ ] `LessonSaveWorker.exportSkill`: after the file is written, call `notify({ type: 'lesson', fingerprint_id: fingerprintId, summary: content.slice(0, 200) })`
- [ ] New test `packages/shared/src/notify.test.ts` covers:
  1. `NOTIFY_WEBHOOK_URL` not set → no fetch call
  2. `NOTIFY_WEBHOOK_URL` set → fetch called with correct URL and `content` field
  3. fetch throws → `notify` swallows, does not re-throw
- [ ] `NOTIFY_WEBHOOK_URL` documented in `.harness/implementation-notes.md`

### Files

- `packages/shared/src/notify.ts` — new file
- `packages/shared/src/index.ts` — add export for `notify`, `NotifyPayload`
- `packages/shared/src/notify.test.ts` — new test file
- `packages/workers/src/memory/crystallize.worker.ts` — add `notify()` call after `occWrite`
- `packages/workers/src/memory/lesson-save.worker.ts` — add `notify()` call inside `exportSkill`

### Implementation notes

Both emoji chars in `formatMessage` are optional — if the deployment target doesn't support Unicode, they degrade gracefully in Discord/Slack. Do not make the format configurable; it's a best-effort diagnostic notification, not a customer-facing product.

The `notify` function is imported from `@graph/shared` in workers (matching the existing import pattern for `writeGuard`, `occWrite`). No new package dependency.

---

## Task 5: Manual verification checkpoint

**Type:** checkpoint:human-verify  
**Effort:** N/A  
**Wave:** 3

### What was built

- T1: `AnthropicProvider` — workers can switch provider via `LLM_PROVIDER=anthropic`
- T2: `CommandGate` module — HARDLINE + DANGEROUS patterns ready; hook comment in `server.ts`
- T3: agentskills.io export — Lessons above confidence threshold write `skills/<id>/SKILL.md`
- T4: Webhook notifications — Crystal and Lesson events POST to `NOTIFY_WEBHOOK_URL`

### Verification steps

1. TypeScript compile — shared:
   ```
   cd packages/shared && npx tsc --noEmit
   ```
   Expected: exits 0.

2. TypeScript compile — workers:
   ```
   cd packages/workers && npx tsc --noEmit
   ```
   Expected: exits 0.

3. Unit tests — shared:
   ```
   cd packages/shared && npx vitest run
   ```
   Expected: all pass, including `anthropic.provider.test.ts`, `command-gate.test.ts`, `notify.test.ts`.

4. Unit tests — workers:
   ```
   cd packages/workers && npx vitest run
   ```
   Expected: all pass, including updated `lesson-save.worker.test.ts`.

5. Smoke-test AnthropicProvider:
   ```
   ANTHROPIC_API_KEY=<key> LLM_PROVIDER=anthropic node -e "
     const { AnthropicProvider } = require('./packages/shared/dist/llm/index.js');
     const p = new AnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY, model: 'claude-haiku-4-5-20251001' });
     p.chat([{ role: 'user', content: 'Reply: ok' }]).then(console.log);
   "
   ```
   Expected: prints `ok` or similar one-word reply.

6. Smoke-test CommandGate:
   ```
   node -e "
     const { checkCommand } = require('./packages/shared/dist/index.js');
     console.log(checkCommand('rm -rf /'));         // { allowed: false, tier: 'hardline', ... }
     console.log(checkCommand('git reset --hard')); // { allowed: false, tier: 'dangerous', ... }
     console.log(checkCommand('git status'));        // { allowed: true }
   "
   ```
   Expected: matches comments.

7. Smoke-test skill export:
   ```
   SKILLS_DIR=/tmp/graph-skills SKILL_EXPORT_THRESHOLD=0.0 node -e "
     // Trigger LessonSaveWorker with a mock pool and confidence=1.0
     // (use a real DB or a pool stub)
   "
   ls /tmp/graph-skills/
   ```
   Expected: directory contains at least one `<fingerprint_id>/SKILL.md`.

8. Smoke-test webhook (use webhook.site for testing):
   ```
   NOTIFY_WEBHOOK_URL=https://webhook.site/<uuid> node -e "
     const { notify } = require('./packages/shared/dist/index.js');
     notify({ type: 'crystal', scope_id: 'test-scope', summary: 'Test crystal content' });
   "
   ```
   Expected: webhook.site receives a POST with `content` field.

### Resume signal

Reply `approved` when all 8 checks pass.

---

## Phase 5 success criteria

- `AnthropicProvider` importable from `@graph/shared`; workers switch provider via `LLM_PROVIDER` env var
- `checkCommand('rm -rf /')` returns `{ allowed: false, tier: 'hardline' }`
- `checkCommand('git status')` returns `{ allowed: true }`
- `skills/<fingerprint_id>/SKILL.md` written when lesson confidence crosses threshold
- `notify()` POSTs to `NOTIFY_WEBHOOK_URL` when set; is a no-op when not set
- All unit tests pass; all TypeScript packages compile without errors
