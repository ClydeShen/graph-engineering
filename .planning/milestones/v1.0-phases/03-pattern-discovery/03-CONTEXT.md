# Phase 3: Pattern Discovery + MCP Bridging — Context

**Gathered:** 2026-06-05
**Status:** Ready for planning
**Source:** Side-branch design sessions (DESIGN.md, D-1~D-7) + ROADMAP.md Phase 3 section

<domain>
## Phase Boundary

Phase 3 extends the original Pattern Discovery goal (CrossScopePatternDiscoveryWorker, WL graph kernel, nested scope activation) with a cross-protocol Agent bridging layer (MCP Server + AgentCard routing), enabling external Agents (Claude, Codex, Pi, etc.) to interact with the execution graph via standard protocols.

**Original Phase 3 scope (ROADMAP):**
- WL graph kernel with topology_embedding computation
- CrossScopePatternDiscoveryWorker
- Nested Scope activation (ADR 23 Phase 3 stubs removed)
- SubScopeResultWorker

**Extended scope (side-branch DESIGN.md, 2026-06-05):**
- MCP Server layer (SSE + HTTP) wrapping the HTTP Gateway
- `agent_registry` table + migration
- FrontierScheduler skill-matching extension (D-1)
- New Gateway endpoints: POST /v1/agents/register, GET /.well-known/agent-card.json, GET /mcp/sse, POST /mcp/messages

ADRs 01–37 remain unchanged. All new components layer on top of existing event model and ledger semantics without introducing new event types.

</domain>

<decisions>
## Implementation Decisions

### D-1: Method B — Skill Routing (LOCKED)
`task_spawned` payload declares `required_skills[]` only. `assigned_agent_id` is forbidden. All task dispatch sovereignty resides in FrontierScheduler, which queries `agent_registry`, matches skills via GIN index, dispatches via SKIP LOCKED.

**Violation guard:** Any payload field named `assigned_agent_id`, `preferred_agent`, or any explicit agent instance pointer is rejected.

**Reason:** Explicit assignment breaks physical equality, prevents cross-agent topology discovery (ADR 37 D-10), and introduces the central-coordinator anti-pattern.

### D-2: AgentCard Universalization (LOCKED)
All participants — internal Workers (Discovery, Frontier, Episodic, etc.) and external Agents (Claude, Codex, Pi, third-party A2A) — register in `agent_registry` with an AgentCard declaring accepted skills.

Minimum AgentCard structure (A2A-protocol compatible):
```json
{
  "agent_id": "uuid-v4",
  "name": "string",
  "description": "string",
  "skills": ["skill-1", "skill-2"],
  "protocol": "mcp | a2a | iii",
  "endpoint": "https://...",
  "version": "1.0"
}
```

### D-3: Three Protocols Coexist (LOCKED)
| Protocol | Target | Transport |
|---|---|---|
| MCP (Model Context Protocol) | Claude, Codex, Pi, LLM Agents | SSE + HTTP |
| A2A (Agent2Agent) | Native A2A third-party systems | JSON-RPC |
| iii WebSocket | Internal Worker processes | WebSocket (existing) |

All three protocols write to the same causal ledger, sharing the same ADR 12 canonical event types (no new event types).

### D-4: Pull Primary, SSE Push Optional (LOCKED)
External Agent task acquisition primary model is Pull:
```
Agent → claim_next_task(skills=[...]) → SKIP LOCKED → returns task or empty
```

SSE Push is a latency optimization (ADR 09 Pulse-Fetch extended outward):
```
PostgreSQL NOTIFY → graph-os MCP SSE → Agent receives signal → calls claim_next_task()
```

Push signals carry no task content; they only trigger. Agent must still actively claim. SKIP LOCKED guarantees atomicity.

### D-5: Ledger as Coordinator, No Central Daemon (LOCKED)
State written to ledger (PostgreSQL), not to process memory.

- Executor crash (token exhaustion, process death) does not lose state — written `memory_updated` events persist independently of the process
- Watchdog (ADR 19) detects heartbeat-timeout claimed tasks, re-queues
- New executor assembles context via ReadOnlyGraphHandle (ADR 35 D-8) from last written point
- Process crash ≠ state loss

**Forbidden patterns:** globally unique guardian daemon, central state server, in-process task state cache.

### D-6: Circular Dependency is a Design Error (LOCKED)
If Agent A waits on Agent B's result, and B tries to dispatch a task back to A (which is blocked and cannot claim), a deadlock forms. This is not a runtime-recoverable scenario.

**Handling (Phase 3):**
- Task TTL + Watchdog as backstop: timeout → mark failed → spawning agent handles error state (Phase 3 backstop)
- spawned_by chain detection at dispatch time: **DEFERRED to Phase 4** (see `<deferred>` section; user decision 2026-06-03)

**Design constraint:** Agent task dependencies MUST form a directed acyclic graph (DAG).

### D-7: Claude Internal Sub-Agent Scheduling NOT Managed by graph-os (LOCKED)
Claude manages its own sub-agent parallel scheduling and state. graph-os only sees the `spawn_subtask` calls Claude emits; it does not observe how Claude distributes these tasks to its internal sub-sessions.

Fan-in (waiting for all completions) is implemented via:
```
wait_all_tasks(task_ids=[id_1, id_2, id_3], timeout_s=300)
```
graph-os internally uses LISTEN/NOTIFY on ledger events; returns once all complete. Avoids N polling rounds.

### Claude's Discretion
- WL graph kernel hyperparameters (iterations, kernel dimension)
- CrossScopePatternDiscovery clustering algorithm details (cosine threshold, minimum cluster size)
- `agent_registry` heartbeat TTL value
- MCP tool call input/output Zod schema specifics
- ADR numbering for new MCP Server component (new ADR 38 vs extension of ADR 24 + ADR 31)
- skills granularity standard (coarse vs fine — resolved during implementation based on routing precision needs)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase 3 Extended Scope
- `.harness/phases/side-branch/DESIGN.md` — full D-1~D-7 decisions + new component specs + agent_registry schema draft + endpoint table
- `.planning/ROADMAP.md` §Phase 3 — original success criteria (topology_embedding cosine > 0.90, CrossScopePatternDiscoveryWorker, nested scope activation)

### Pattern Discovery
- `docs/adr/0039-adr37-pattern-discovery-schedule.md` — ADR 37 D-10: cron schedule, corpus guard, OLTP slot isolation
- `docs/adr/0027-adr25-cross-domain-topology-algorithm.md` — ADR 25: topology_embedding vector(128), WL graph kernel algorithm, HNSW search

### Frontier Scheduler (Extension)
- `docs/adr/0033-adr31-frontier-scheduler-architecture.md` — ADR 31: FrontierScheduler core, priority formula, SKIP LOCKED dispatch — Phase 3 extends skill-matching logic on top

### Nested Scopes
- `docs/adr/0025-adr23-nested-scope-propagation.md` — ADR 23: nested scope propagation, sub_scope_resolved event, Phase 3 activation (stubs to be removed)

### Infrastructure (unchanged)
- `docs/adr/0026-adr24-agent-entry-point-protocol.md` — ADR 24: HTTP Gateway — MCP Server layers on top, does not replace
- `docs/ADR_v4.md` — ADR 01–37 overview, locked decisions
- `.planning/REQUIREMENTS.md` — Phase 1 requirements (architecture base; Phase 3 builds on this)

</canonical_refs>

<specifics>
## Specific Requirements

### MCP Tools to Implement
| Tool | Semantics |
|---|---|
| `spawn_subtask(required_skills, payload)` | Writes task_spawned event, returns task_id |
| `claim_next_task(skills)` | SKIP LOCKED atomic claim, returns task or empty |
| `get_task_status(task_id)` | Queries ledger, returns task state |
| `complete_task(task_id, result)` | Writes memory_updated event, marks done |
| `wait_all_tasks(task_ids, timeout_s)` | Server-side aggregation, returns when all complete |
| `register_agent(agent_card)` | Writes to agent_registry |
| `query_context(scope_id)` | Reads causal-chain context summary |

### agent_registry Schema (from DESIGN.md)
```sql
CREATE TABLE agent_registry (
  agent_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  description     TEXT,
  skills          TEXT[] NOT NULL DEFAULT '{}',
  protocol        TEXT NOT NULL CHECK (protocol IN ('mcp', 'a2a', 'iii')),
  endpoint        TEXT,
  agent_card_json JSONB NOT NULL,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat  TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);
CREATE INDEX idx_agent_registry_skills ON agent_registry USING GIN (skills);
```

### New Endpoints
| Endpoint | Protocol | Description |
|---|---|---|
| `GET /.well-known/agent-card.json` | HTTP | graph-os self AgentCard |
| `POST /v1/agents/register` | HTTP | Register external Agent |
| `GET /mcp/sse` | SSE | MCP event push (Pulse-Fetch extension) |
| `POST /mcp/messages` | HTTP | MCP tool call entry point |

### Phase 3 Gate (Gate 4) — Success Criteria
1. Two topologically equivalent scopes from different domains have `topology_embedding` cosine similarity > 0.90
2. CrossScopePatternDiscoveryWorker writes `cross_domain_cluster_id` for matching template pairs
3. Nested scopes fully activate: child scope `scope_closed` propagates to parent via `sub_scope_resolved`
4. External Agent (MCP client) can call `spawn_subtask` + `claim_next_task` + `complete_task` against a live graph-os instance
5. FrontierScheduler dispatches tasks by skill match (not arbitrary assignment)

</specifics>

<deferred>
## Deferred to Phase 4
- Pi SDK `runtime.fork()` sandbox rehearsal mode (ADR Phase 4)
- Distributed lock for ConflictResolverWorker (replacing in-memory Phase 2 ActiveResolverRegistry)
- A2A JSON-RPC full implementation (Phase 3 only scaffolds the protocol; full A2A spec compliance is Phase 4)
- wait_all_tasks partial-completion semantics (timeout = return partial result or error — deferred pending Phase 3 integration test findings)
- D-6 FrontierScheduler spawned_by chain detection at dispatch time (Phase 4; Watchdog TTL is Phase 3 backstop)
</deferred>

---

*Phase: 03-pattern-discovery*
*Context gathered: 2026-06-05 from DESIGN.md (side-branch sessions) + ROADMAP.md Phase 3*
