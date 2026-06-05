---
spike: "004"
name: pi-extension
type: standard
validates: "Given a Pi ExtensionAPI host, when our extension loads, then spawn_task/complete_task register as Pi tools, /fork activates InMemoryShadowAdapter, /fork-end calls clear() (阅后即焚), tool_call hook guards destructive ops in rehearsal"
verdict: VALIDATED
related: ["003", "005"]
tags: [pi-sdk, extension, rehearsal, tool-registration]
---

# Spike 004: Pi Extension

## What This Validates

Given `@earendil-works/pi-coding-agent` ExtensionAPI, when `graphRuntimeExtension(pi)` is called:
1. `spawn_task` and `complete_task` register as Pi-native tools
2. `/fork <entry-id>` command calls `runtime.fork(entryId)` + activates `InMemoryShadowAdapter`
3. `/fork-end` calls `shadow.clear()` — 阅后即焚
4. `tool_call` event handler guards destructive bash commands in rehearsal mode
5. `session_start` event announces interactive vs rehearsal mode

## How to Run

```bash
npx tsx .planning/spikes/004-pi-extension/extension/src/verify.ts
```

## What to Expect

7 structural tests (no live Pi instance required), all PASS.

## Pi SDK Reality (from context7 research)

| API | Status | Notes |
|---|---|---|
| `ExtensionAPI` | Real SDK type | `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` |
| `pi.registerTool()` | Real SDK method | Registers tool in Pi's tool palette |
| `pi.registerCommand()` | Real SDK method | Registers `/cmd` slash command |
| `pi.on("session_start")` | Real SDK event | Fires when Pi session starts |
| `pi.on("tool_call")` | Real SDK event | Intercept + optionally block tool calls |
| `runtime.fork(entryId)` | Real SDK method | Creates new Pi session from entry point |
| `SessionManager.inMemory()` | Real SDK method | In-memory session (no file I/O) |

## Investigation Trail

**Pi is NOT our own component:** Pi = `@earendil-works/pi-coding-agent`, an external AI coding agent (like Claude Code). We build a Pi *extension* — a TypeScript package that Pi loads from `~/.pi/agent/extensions/`.

**Extension entry format (package.json):**
```json
{
  "pi": { "extensions": ["./src/index.ts"] }
}
```

**Pi Terminal = Pi loaded with our extension.** Users run Pi; our extension gives them `spawn_task`, `complete_task`, `/fork`, and `/fork-end` as native Pi tools.

**Shadow adapter lifecycle:**
- Module-level `activeShadow: InMemoryShadowAdapter | null` — single flag per Pi session
- `/fork` → `activeShadow = new InMemoryShadowAdapter(realPool)` + `ctx.runtime.fork(entryId)`
- All `spawn_task`/`complete_task` tool calls pass `activeShadow` to `callMcp()` — MCP layer uses `.proxy` for writes
- `/fork-end` → `activeShadow.clear(); activeShadow = null`

**agentmemory comparison:** Their `pi.ts` is a stub (manual install, no tool registration). We implement the full version.

## Key Decisions for Phase 4

| Decision | Value |
|---|---|
| Extension package | `packages/pi-extension/` in monorepo |
| Pi tools exposed | `spawn_task`, `complete_task` (Phase 4); others added later |
| Fork activation | `/fork <entry-id>` command (not automatic) |
| Shadow state | Module-level singleton (one rehearsal session at a time) |
| Rehearsal guard | `tool_call` event blocks `rm`, `git push`, `git commit`, `psql` |
| Pi SDK install | `@earendil-works/pi-coding-agent` added to pi-extension package.json only |
