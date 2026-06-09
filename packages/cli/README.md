<!-- generated-by: gsd-doc-writer -->
# @graph/cli

Connect coding agents to the Memex graph-native agent runtime via an interactive onboarding TUI.

Part of the [graph-enginerring](../../README.md) monorepo.

## Usage

```bash
npx graph-runtime connect
# or, once installed as a workspace tool:
node packages/cli/src/index.ts
```

Running `graph-runtime connect` launches an interactive TUI (powered by `@clack/prompts`) that lets you select which agents to wire up.

```
graph-runtime connect

Options:
  --help, -h    Show this help message

Agents:
  claude-code   Claude Code (MCP) — patches ~/.claude.json
  pi            Pi Terminal (extension) — installs into ~/.pi/agent/extensions/
```

## Agents

### Claude Code (MCP)

Patches `~/.claude.json` to register a `graph-runtime` MCP server entry:

```json
{
  "mcpServers": {
    "graph-runtime": {
      "type": "http",
      "url": "http://localhost:4000/mcp"
    }
  }
}
```

The target URL defaults to `http://localhost:4000/mcp`. Override with environment variables before running:

| Variable | Default | Description |
|---|---|---|
| `GRAPH_RUNTIME_URL` | `http://localhost:4000` | Base URL of a running Memex instance |
| `GRAPH_RUNTIME_SECRET` | _(unset)_ | If set, adds `Authorization: Bearer <secret>` to MCP headers |

A timestamped backup of the existing `~/.claude.json` is created automatically if the file is present.

### Pi Terminal (extension)

Copies the `@graph/pi-extension` source files into `~/.pi/agent/extensions/graph-runtime/` and registers the extension path in `~/.pi/agent/settings.json`.

Requires Pi to be installed first. If `~/.pi` is not found, the CLI exits with guidance to install Pi.

## Re-running / Force reinstall

If an agent is already wired, the CLI skips it and prints a warning. There is no `--force` flag exposed in the TUI yet — to reinstall, remove the existing entry from `~/.claude.json` or `~/.pi/agent/settings.json` and run the command again.

## Testing

```bash
npm run test --workspace=packages/cli
```
