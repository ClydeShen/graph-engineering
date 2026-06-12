# MCP Server Config Compatibility — Memex ↔ Claude Code ↔ Hermes

Memex `mcp_servers` entries (in `~/.memex/config.json`) use the same field
vocabulary as Claude Code and Hermes so existing entries port verbatim.

## Field mapping

| Concept | Memex `mcp_servers.<name>` | Claude Code `mcpServers.<name>` | Hermes `mcp_servers.<name>` |
|---|---|---|---|
| stdio executable | `command` | `command` | `command` |
| stdio arguments | `args` | `args` | `args` |
| stdio environment | `env` | `env` | `env` |
| HTTP endpoint | `url` | `url` (+ `type: "http"`) | `url` |
| HTTP headers | `headers` | `headers` | `headers` |
| OAuth | `auth: "oauth"` | implicit (Claude Code auto-detects) | `auth: oauth` |
| Tool filter | `tools.include` / `tools.exclude` | permissions layer (`mcp__server__tool` rules) | `tools.include` |
| Enable toggle | `enabled` | `enabledMcpjsonServers` / `disabledMcpjsonServers` | `enabled` |
| Env var references | `${VAR}` (resolved at load, never written back) | `${VAR}` | `${VAR}` |

Notes:

- **Transport selection**: an entry has exactly `command` (stdio) or `url`
  (http/streamable) — same convention in all three systems.
- **Tool filtering**: Claude Code keeps per-tool control in its permissions
  layer, not in the server entry. When mirroring to Claude Code
  (`memex connect claude-code --include-mcp-servers`), Memex copies the
  connection fields only; set tool permissions in Claude Code's settings.
- **OAuth tokens are never mirrored.** Each system runs its own PKCE flow.
  Memex caches tokens at `~/.memex/mcp-tokens/<server>.json` (cf. Hermes
  `~/.hermes/mcp-tokens/<server>.json`); run `memex mcp login <name>`.
- **Desired state vs observed state (ADR-51)**: in Memex, `tools`/`enabled`
  are desired-state inputs. The effective tool surface after connection is
  recorded into the graph (`memex::capability::surface_changed`), which is
  the authoritative record of what the server actually exposes.

## Porting examples

Claude Code → Memex (stdio):

```jsonc
// ~/.claude.json                        // ~/.memex/config.json
{ "mcpServers": {                        { "mcp_servers": {
    "filesystem": {                          "filesystem": {
      "type": "stdio",                         "command": "npx",
      "command": "npx",            →           "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }                                        }
} }                                      } }
```

Hermes → Memex (http + oauth): identical YAML→JSON transliteration; field
names are unchanged.
