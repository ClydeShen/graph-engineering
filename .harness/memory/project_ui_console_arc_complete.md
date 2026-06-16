---
name: project_ui_console_arc_complete
description: "ui-console arc — embedded chat + Hermes-parity pages + first-run handoff, all live-verified"
metadata: 
  node_type: memory
  type: project
  originSessionId: 7c30552c-d95b-427b-9507-d8611736e880
---

UI-console arc complete (2026-06-13, commits 6c376cfa..43ab5cb8). Resolves the
paused chat-embedding fork from [[project_console_unifies_to_graph_projection]]:
embedded chat lives in the Dashboard AND does not duplicate MemexTerminal —
both drive the single ADR-54 conversation core.

Shipped:
- **ds/ redesign committed** (6c376cfa) after verifying render; fixed @import
  order in globals.css (imports must precede @tailwind base).
- **/chat page** (b41c95e3): assistant-ui LocalRuntime + primitives over a
  server-side SSE bridge `/api/chat` that holds gateway.token server-side and
  re-emits text_delta. New `GET /v1/scopes/:id/messages` for session resume.
  Next 15→16 (assistant-ui needs React 19.2 useEffectEvent). Embedding zero-pad
  to vector(1536) at provider boundary (BGE-M3=1024/Gemini=768 failed inserts).
- **First-run handoff** (1201cd02): dev.mjs TTY boot, after health, clears the
  log firehose and spawns MemexTerminal; logs keep flowing to ~/.memex/logs/
  dev.log. New `memex log` tails it. Gated on isTTY (agent/CI keep streaming).
- **Hermes-parity pages** (d8bfc542): Sessions (scope browser + conversation
  replay + deep-links), Activity (`GET /v1/metrics/activity` graph aggregation +
  Recharts), Settings (`GET /v1/sys/config` redacted; wires the no-op gear).
- **MemexTerminal polish** (294dca0f) + markdown list-marker fix (bfc01bfb,
  Tailwind preflight had reset list-style).

DEFERRED (not built): write/control pages (Env secrets, Plugins/MCP marketplace,
Cron, Profiles CRUD) — CLI-covered + need trust-isolation/ADR-47 review before
becoming Dashboard write surfaces. docs/UI-SPEC.md still stale.

Verified live via agent-browser against local llama.cpp Qwen3-35B (chat :8080) +
BGE-M3 (embeddings :8082). Unit suites green (root 72, gateway 127). Local config
written to ~/.memex/config.json this session (original Gemini → config.json.bak-gemini).
Console nav: Chat·Sessions·Topology·Activity·Kernel·Alerts·Artifacts·Skills.
