# Hermes Agent → Graph Runtime: Gap Analysis & Extension Map

**Date:** 2026-06-07  
**Method:** Hermes deep research report (`.harness/analysis/hermes-agent-deep-research-report.md`) vs current project state (`PROJECT.md` + Phase 4 plan)

---

## Current Project Snapshot

| Layer | Status |
|---|---|
| Execution graph (PostgreSQL, append-only) | ✅ Core done |
| OCC write-guard + hash chain | ✅ Done |
| ConflictResolverWorker (pg_try_advisory_lock) | ✅ Phase 4 done |
| SemanticMemoryWorker + MemorySynthesizerWorker | ✅ Done |
| CrystallizeWorker + LessonSaveWorker | ✅ Phase 4 done |
| MCP HTTP gateway (`/mcp`) | ✅ Done |
| Claude Code + Pi Terminal connect CLI | ✅ Phase 4 done |
| LLM provider | Single: OpenAI-compatible REST only |
| Tool safety / command approval | None |
| Multi-platform gateway | None |
| User modeling (cross-session) | None (only per-scope episodic memory) |
| Notification/cron delivery | Basic (MemorySynthesizerWorker 2AM) |

---

## Category 1 — Directly Integrable (high structural alignment)

These map cleanly onto the current graph paradigm without design changes.

### 1.1 Multi-provider LLM abstraction

**What hermes does:** 3-layer provider system — declarative dataclass (`ProviderProfile`), plugin discovery, wire protocol per provider (`chat_completions` / `anthropic_messages` / `codex_responses` / `bedrock_converse`). Entry point: `build_api_kwargs()` at `agent/chat_completion_helpers.py:527`.

**Current gap:** The project uses a single `OpenAI-compatible REST` endpoint. Every worker that calls LLM (`SemanticMemoryWorker`, `CrystallizeWorker`) hardcodes OpenAI format.

**Integration path:** Add an `LLMProvider` interface with `chat()` method (already implied in Phase 4 worker constructors). Back it with adapters: `OpenAIAdapter`, `AnthropicAdapter`. Wire via environment variable (`LLM_PROVIDER=anthropic|openai|local`). This is a 1-file abstraction (the `LLMProvider` interface already exists as a constructor type — just needs runtime-selectable implementations).

**Value:** Users can run the graph runtime against any provider without code changes.

---

### 1.2 MCP as first-class tool consumer (inbound)

**What hermes does:** External MCP servers run as separate processes. Hermes connects to them on a dedicated background asyncio event loop (`tools/mcp_tool.py`). Their tools appear as native agent tools.

**Current gap:** The graph runtime IS an MCP server (outbound). It does not currently consume external MCP servers as inputs.

**Integration path:** Add an `McpClientWorker` that connects to configured MCP server URLs and registers their tools as callable functions within the execution graph. Each MCP tool call becomes a hyper-edge in the graph with full causal lineage. This is Phase 5 territory — but the groundwork (MCP HTTP endpoint, iii worker pattern) is complete.

**Value:** The graph runtime can consume any MCP-compatible tool (web search, file systems, databases) and record full causal lineage of every tool call.

---

### 1.3 agentskills.io format for discovered patterns

**What hermes does:** Skills are `SKILL.md` + YAML frontmatter files. Compatible with Anthropic's open standard (adopted by Claude Code, Cursor, GitHub Copilot, Gemini CLI). Progressive disclosure: only name+description loaded at startup, full content on activation.

**Current gap:** Procedural memory (Lessons) is stored in PostgreSQL as raw text. Discovered patterns have no external-facing format.

**Integration path:** When `LessonSaveWorker` creates or reinforces a Lesson with confidence ≥ threshold, export it as a `skills/<fingerprint_id>/SKILL.md` file. This makes discovered graph patterns usable by any agentskills.io-compatible agent — including the user's Claude Code instance.

**Value:** Workflow emergence becomes observable and portable. The graph runtime becomes a skill generator, not just a recorder.

**Effort:** Low. `LessonSaveWorker` already has the content; adding file write on threshold crossing is ~30 lines.

---

### 1.4 Command approval safety layer

**What hermes does:** 3-tier gate: (1) HARDLINE_PATTERNS (12, never executable — not even with --yolo); (2) DANGEROUS_PATTERNS (54 regexes, require user approval); (3) Smart LLM approval via `tools/approval.py`. Entirely pre-execution.

**Current gap:** The graph runtime has no command safety layer. When agents registered via MCP call `bash` or file-write tools, there is no gate.

**Integration path:** Add a `CommandGate` module in `packages/shared` with a port of the hardline + dangerous pattern logic (TypeScript). Wire it into the MCP tool dispatch path (`packages/gateway/src/routes/mcp.ts`) before any tool call is executed. LLM-approval tier can come later.

**Value:** Prevents the graph runtime from being used as a privilege escalation vector when serving untrusted agents.

**Effort:** Medium. Pattern port is mechanical; the integration point in `mcp.ts` is clear.

---

### 1.5 Cron/notification delivery routing

**What hermes does:** `DeliveryRouter` (`gateway/delivery.py:175`) + `_HOME_TARGET_ENV_VARS` (`cron/scheduler.py:124`) routes scheduled notifications to wherever the user has set as home (Telegram, Discord, etc.), with live-adapter path and standalone fallback.

**Current gap:** `MemorySynthesizerWorker` runs at 2AM but its output goes nowhere — it writes to the DB but there's no delivery path to the user.

**Integration path:** Add a `NotifyChannel` abstraction (initially just a webhook URL env var). When `CrystallizeWorker` produces a Crystal or a Lesson crosses the confidence threshold, post a structured notification. Start with webhook (Discord/Slack webhook URL requires zero auth setup), extend later to full gateway routing.

**Value:** Users learn about discovered patterns without polling the database.

**Effort:** Low for webhook-only path. 1 env var + 1 `fetch()` call in `CrystallizeWorker`.

---

## Category 2 — Functional Extensions (additive, not core)

These are valuable capabilities that don't conflict with the current design but are not yet needed for the core graph runtime.

### 2.1 Multi-platform messaging gateway

**What hermes does:** `GatewayRunner` (`gateway/run.py:1676`) + `PlatformRegistry` manages 20+ platform adapters (Telegram, Discord, Slack, WhatsApp, Signal, Line, etc.) via a single `asyncio` process. Session routing via `build_session_key()`. `/sethome` command sets notification target.

**Extension path:** A `packages/gateway` package that wraps the graph runtime's MCP server with a messaging adapter layer. Each incoming message triggers a task spawn; each Crystal/Lesson is delivered to the sender's platform. Start with Telegram (simplest long-poll, no public URL required) and Discord.

**Value:** Turn the graph runtime into an always-on agent accessible from any device, with pattern discoveries surfacing as chat messages.

**Complexity:** High standalone, low with hermes as reference — the adapter pattern and session key format are proven.

---

### 2.2 Terminal execution isolation (Docker backend)

**What hermes does:** `_BASE_SECURITY_ARGS` (`tools/environments/docker.py:324`): `--cap-drop ALL`, `--security-opt no-new-privileges`, `--pids-limit 256`, nosuid tmpfs. Selected via `TERMINAL_ENV` env var.

**Extension path:** When the graph runtime executes agent-requested bash commands (via future `execute_code` tool), route execution into a Docker sandbox using the same args pattern. The `SANDBOX_ALLOWED_TOOLS` (7 tools) pattern maps directly to what the MCP gateway should expose.

**Value:** Prevents agent bash execution from affecting the host system.

**Complexity:** Medium. Docker SDK is well-documented; the security arg pattern is lifted verbatim.

---

### 2.3 Honcho cross-session user modeling

**What hermes does:** Honcho (`plastic-labs/honcho`) builds a persistent user model ("peer") across sessions using dialectic reasoning — background async inference on ingested messages.

**Current gap:** Each scope is independent. The graph has no cross-scope user model. The user's preferences, beliefs, and working patterns are lost when a scope closes.

**Extension path:** After `CrystallizeWorker` produces a Crystal, additionally call a Honcho-style user model update. Since the graph already stores all episodic traces, a simpler internal approach: add a `UserProfileWorker` that reads Crystals across scopes for a given user entity and synthesizes a user profile entity in the graph. No external dependency required — it's the same LLM + graph write pattern.

**Value:** The graph becomes user-aware over time, not just task-aware.

**Complexity:** Medium. The data is available; a new worker is needed.

---

### 2.4 Skill discovery UI / TUI

**What hermes does:** `prompt_toolkit` TUI with multiline editing, autocomplete (COMMAND_REGISTRY 60+ slash commands), push-to-talk voice mode. Entry: `hermes_cli/cli.py:HermesCLI`.

**Extension path:** A minimal `packages/tui` package using `@inquirer/prompts` (Node.js equivalent) or `blessed` for browsing the execution graph, inspecting discovered patterns, and triggering scope close/crystallize manually.

**Value:** Makes the graph runtime observable without a database client.

**Complexity:** Low for read-only inspection. High for full TUI.

---

### 2.5 Cryptographic session trust (DM pairing)

**What hermes does:** SHA-256 + random 16-byte salt, 1hr TTL, 5-attempt lockout, 0o600 file perms. Generates a short code the user receives in-chat to authorize the connection (`gateway/pairing.py`).

**Extension path:** For multi-user graph runtime deployments (multiple agents sharing one PostgreSQL), add a pairing step: each new agent connection generates a short code that must be confirmed by the graph runtime operator before that agent can write to the graph.

**Value:** Prevents unauthorized agents from writing to the graph.

**Complexity:** Low. The pattern is fully specified in hermes; port to TypeScript is straightforward.

---

## Priority order (recommendation)

| Priority | Feature | Rationale |
|---|---|---|
| **P0** | 1.1 Multi-provider LLM | Blocks adoption — users shouldn't be locked to OpenAI |
| **P0** | 1.4 Command approval safety | Security gap in current MCP tool dispatch |
| **P1** | 1.3 agentskills.io export | High leverage — makes pattern discovery visible and portable |
| **P1** | 1.5 Notification delivery | Closes the "discoveries go nowhere" gap |
| **P2** | 1.2 MCP client (inbound) | Enables graph to consume external tools with full lineage |
| **P2** | 2.1 Messaging gateway | Major UX unlock, but high effort |
| **P3** | 2.3 User modeling | Depends on mature Crystal stream |
| **P3** | 2.2 Docker isolation | Depends on execute_code tool existing |
| **P4** | 2.5 DM pairing | Only relevant at multi-user scale |
| **P4** | 2.4 TUI | Convenience, not capability |

---

## What does NOT transfer from hermes

| Hermes feature | Reason not applicable |
|---|---|
| STT/TTS voice backends | Graph runtime is not a conversation agent |
| Image/video generation | Niche, not graph-paradigm relevant |
| s6-overlay process supervision | iii Engine already handles worker lifecycle |
| OpenClaw migration wizard | Hermes-specific product history |
| 6 terminal backends (Modal, Daytona, Singularity) | Overkill for current scale; Docker is sufficient |
| `faster-whisper` local STT | Only relevant if voice is added |
