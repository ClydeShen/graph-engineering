<!-- generated-by: gsd-doc-writer -->
# @graph/pi-extension

Pi Terminal SDK extension that connects an external Pi coding agent to the Graph Runtime execution graph.

Part of the [graph-engineering](../../README.md) monorepo.

## What it does

This package is a Pi extension — a module loaded by the Pi coding agent via the `"pi".extensions` field in `package.json`. It:

- Registers two tools (`spawn_task`, `complete_task`) that proxy to the Graph Runtime MCP endpoint at `GRAPH_RUNTIME_URL/mcp`
- Adds two slash commands (`/fork-ext`, `/fork-end`) for entering and exiting rehearsal mode
- Guards destructive bash commands (`rm`, `git push`, `git commit`, `psql`) while rehearsal is active

## Rehearsal mode

Rehearsal mode is a shadow-write fork. All writes go to an in-memory adapter instead of the real graph. There are two ways to activate it:

| Path | How |
|---|---|
| Pi's native `/fork <entryId>` | `session_before_fork` event fires → shadow activates automatically |
| `/fork-ext <entryId>` | Explicit activation; also calls `ctx.fork(entryId)` |

Exit rehearsal with `/fork-end`. All shadow entries are destroyed on exit (阅后即焚).

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `GRAPH_RUNTIME_URL` | No | `http://localhost:4000` | Base URL for the Graph Runtime MCP endpoint |

## Registered tools

### `spawn_task`

Spawn a task entity in the execution graph.

```json
{
  "scope_id": "scope-uuid",
  "title": "My task",
  "payload": {}
}
```

### `complete_task`

Mark an existing task entity complete.

```json
{
  "entity_id": "entity-uuid",
  "scope_id": "scope-uuid",
  "result": {}
}
```

In rehearsal mode both tools route writes to the shadow adapter; `shadow_entries` in the response shows the current buffered count.

## Key exports

```typescript
import graphRuntimeExtension from '@graph/pi-extension';
// default export — pass to Pi's extension loader

import { isRehearsalActive, getShadow } from '@graph/pi-extension';
// isRehearsalActive(): boolean — true when shadow is live
// getShadow(): InMemoryShadowAdapter | null — direct shadow access for tests
```

## Testing

```bash
npm run test --workspace=packages/pi-extension
```

> Note: this package is `"private": true` and is not published to npm.
