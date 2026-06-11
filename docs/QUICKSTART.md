# MemexOS Quickstart — first Trail in five minutes

MemexOS is a graph-native agent runtime: every agent action is an immutable
event in a PostgreSQL ledger (the Trail Mesh), and the agent's context window
is assembled per call from that graph. Nothing here is a chat log — it's a
causal record that the system learns from.

## 1. Install (one line)

**Linux / macOS / WSL2**

```sh
curl -fsSL https://raw.githubusercontent.com/ClydeShen/graph-enginerring/master/scripts/install.sh | sh
```

**Windows (native PowerShell)**

```powershell
iex (irm https://raw.githubusercontent.com/ClydeShen/graph-enginerring/master/scripts/install.ps1)
```

The installer detects Node 22 and PostgreSQL (reusing a local server, or
starting the bundled Docker Postgres), runs migrations, and hands off to the
onboarding TUI for provider keys and gateway settings.

**Docker all-in-one** (no local Node needed beyond the install itself):

```sh
docker compose -f deploy/docker-compose.yml up -d
```

Add `-f deploy/docker-compose.hardened.yml` for network-isolated services with
dropped privileges — the recommended shape for anything reachable from outside.

## 2. Check the installation

```sh
memex doctor
```

Eight independent checks: config, Node version, Postgres + extensions,
migration watermark, **hash-chain integrity** (sampled live), LLM providers,
gateway, channel tokens. Doctor diagnoses and never changes anything.

## 3. Start the runtime

```sh
npm run dev          # dev: iii engine → workers → control plane + gateway
```

(or the Docker compose above, or `memex service` to generate
systemd/launchd/Scheduled Task files for boot-time startup.)

## 4. Blaze your first Trail

Create a Scope (a unit of intent) and write your first event:

```sh
curl -X POST http://localhost:4000/v1/scopes \
  -H "Content-Type: application/json" \
  -d '{"intent": "my first trail"}'
```

The response contains a `scope_id` and `plan_hash`, plus an assembled context.
Write an event using that hash as the predecessor:

```sh
curl -X POST http://localhost:4000/v1/scopes/<scope_id>/events \
  -H "Content-Type: application/json" \
  -d '{
    "entity_id": "11111111-1111-4111-8111-111111111111",
    "event_type": "memory_updated",
    "payload": {"note": "hello, Trail Mesh"},
    "predecessor_hash": "<plan_hash>"
  }'
```

You get back `occ_result: "won"`, a new `version_hash` (the chain extends), and
a fresh context projection. That's the whole paradigm in two calls: **write to
the graph, read a projection of the graph.**

## 5. Connect an agent

```sh
memex connect        # wires Claude Code (MCP) and/or Pi Terminal
```

Agents then work through MCP tools (`spawn_subtask`, `claim_next_task`,
`complete_task`, …) against the same ledger. As scopes close, the system
crystallizes Lessons from trails, reinforces what works (Ebbinghaus schedule),
and starts injecting proven trail templates into future scopes — that's Trail
Discovery, and it's measurable: run the eval journey to see hit rate,
retention, and compression metrics.

```sh
npx tsx scripts/eval/journey.ts
```

## Where to go next

- `SECURITY.md` — the trust model (read before exposing anything)
- `memex skills search <topic>` — install community skills (guard-scanned)
- `memex backup` / `memex restore` — ledger backup with chain re-verification
- `docs/adr/` — every architectural decision, in order, with rationale
