---
phase: 6
reviewers: [gemini, codex]
reviewed_at: 2026-06-09T15:05:00.000Z
plans_reviewed: [06-PLAN.md]
skipped_reviewers:
  claude: running environment (self-review excluded)
  opencode: returned empty output
---

# Cross-AI Plan Review — Phase 6

## Gemini Review

Based on the Phase 6 implementation plans and the current state of the Memex project, here is the structured Cross-AI Review.

### Summary
Phase 6 effectively transitions Memex from a passive ledger into an interactive agent runtime. By integrating the Model Context Protocol (MCP) for inbound tool consumption and establishing messaging gateways, the system moves closer to a production-ready "associative trail" environment. However, the introduction of host-level command execution and the proposed "Integration Scope" for MCP tool results introduce significant security and architectural risks that require mitigation before implementation.

### Strengths
- **Ecosystem Leverage**: Task 1 (McpClientWorker) correctly identifies MCP as the standard for inbound tool discovery, allowing the runtime to scale its capabilities without building custom wrappers for every service.
- **Design Alignment**: Task 4 (UserProfileWorker) implements "dialectic user modeling" entirely within the graph paradigm, honoring the vision of "workflow emergence from execution history" without external SaaS dependencies.
- **Defense in Depth**: Task 5 adds a necessary layer of per-agent trust (pairing codes) on top of the existing bearer token authentication, which is essential for multi-user environments.
- **Strategic Pivot**: Correctly superseding T6 (TUI) in favor of the MemexShell Dashboard avoids "fragmented UI" debt and aligns with the locked ROADMAP.md North Star.

### Concerns

**1. Security of `execute_bash` (Severity: HIGH)**
- The plan uses `child_process.exec` directly on the host machine. While CommandGate has 66 regex patterns, regex-based security is inherently bypassable via shell expansions, `base64` obfuscation, or multi-stage payloads.
- Impact: A single bypass results in full host compromise.
- Requirement: Execution MUST be sandboxed. If Docker isolation is deferred, use a minimal `chroot` or `nsenter` wrapper at minimum, or pull forward the Docker backend requirement.

**2. Causal Lineage & Tool Context (Severity: HIGH)**
- Task 1 proposes recording MCP tool results in a "dedicated integration scope." In the Memex architecture, the context window is a projection of a specific Scope UUID. If a tool result is written to a separate integration scope, the agent that called the tool will be unable to "see" the result in its subsequent context assembly.
- Impact: Agents will call tools successfully but will appear "blind" to the results, leading to loop failures.
- Requirement: Tool results must be written back to the **calling Scope ID** with a valid predecessor hash. McpClientWorker must bridge the calling context from iii to the occWrite call.

**3. OCC Chain Tracking in McpClientWorker (Severity: MEDIUM)**
- The plan does not detail how predecessor hash is tracked for the integration scope. If multiple tools from different servers write to the same scope/entity, they will race.
- Impact: Frequent `occ_result='demoted'` results and broken hash chains.
- Requirement: Each tool should have its own entityId to minimize contention.

**4. In-Memory Pairing Persistence (Severity: LOW)**
- Task 5 uses an in-memory Map. All agent pairings are lost on process restart, creating a "re-pairing storm" in containerized environments during routine deployments.
- Suggestion: Persist pairing status in a simple `agent_pairing` table in PostgreSQL.

**5. Messaging Gateway Idempotency (Severity: MEDIUM)**
- Task 3 Telegram long-polling relies on an in-memory offset. If the gateway crashes after spawning a task but before updating the offset, it will re-spawn the same task on restart.
- Requirement: Use Telegram/Discord update_id/interaction_id as part of an occWrite idempotency key.

### Suggestions
- **Context Injection**: Modify McpClientWorker tool registration to automatically append `scope_id` and `predecessor_hash` to the tool's input schema. This ensures the bridge is "Memex-aware."
- **CommandGate Smart Error**: Return structured JSON for DANGEROUS blocks to allow Gateway-Bot or Dashboard to present a "Manual Override" or "Approve" button.
- **Stable UUIDs**: Ensure `USER_PROFILE_SCOPE_ID` and the MCP integration scope ID are registered in `agent_registry` or a `system_scopes` table to prevent foreign key violations during occWrite.

### Risk Assessment
The primary risk is **Host Integrity**. The jump from a passive graph to an execution-capable runtime via `execute_bash` is the largest security surface increase in the project's history. The secondary risk is **Causal Fragmentation** — if Task 1's "integration scope" pattern is followed for results, the associative nature of the graph is broken, rendering external tools "unreachable" for the agent's logic.

**Verdict**: The plan is architecturally sound but requires a "Context Bridge" update for Task 1 and a "Sandbox First" approach for Task 2.

---

## Codex Review

### Summary
Phase 6 is directionally useful, but the plan currently under-specifies several security and correctness boundaries. The highest-risk areas are `execute_bash`, OCC lineage for externally triggered events, and the in-memory pairing model. There is also a clear inconsistency: T6 is superseded, but the success criteria and manual verification (T7 step 6) still require `graph-tui`.

**Verdict: Not approved as-is.** Needs tightening around command execution isolation, causal predecessor tracking, authentication/authorization, messaging idempotency, and removal of all T6 references.

### Strengths
- `EXECUTE_BASH_ENABLED=false` by default is the right baseline for a network-accessible MCP server.
- CommandGate is explicitly placed before execution — correct ordering.
- External MCP calls recorded as graph events preserves the project's causal auditability model.
- Telegram long-polling includes offset management and retry handling.
- Agent pairing gated behind `REQUIRE_AGENT_PAIRING=true` — can be introduced without breaking single-user setups.
- T6 being explicitly superseded avoids building a UI surface that conflicts with the MemexShell decision.

### Concerns

**HIGH: `execute_bash` is still remote code execution with weak containment**

CommandGate filtering plus `child_process.exec` is insufficient for a network-accessible MCP server. Even "safe" commands can exfiltrate secrets, enumerate the filesystem, consume CPU, write files, invoke interpreters, or chain through shell metacharacters.

Specific gaps:
- `exec` invokes a shell: quoting, expansion, pipes, redirects, command substitution, and environment access are all in scope
- No working directory restriction specified
- No environment scrubbing specified
- No UID/user isolation specified
- No network restriction specified
- No allowlist mode specified
- No audit event written for blocked attempts — only successful execution results are recorded
- `scope_id` and `predecessor_hash` are client-supplied, allowing callers to attach execution results to arbitrary graph lineage

**HIGH: OCC predecessor chain tracking is underspecified in McpClientWorker**

The plan says external MCP calls happen "outside a specific scope context" and uses a dedicated integration scope, but each call still needs a valid predecessor hash. The plan does not define how the worker reads, updates, serializes, or retries that predecessor chain.

Risks:
- Concurrent MCP tool calls in the same integration scope can race
- A stale predecessor hash causes OCC write failure
- Naive retries may cause duplicate external side effects
- Ignored failures silently lose tool results from the graph
- A single integration scope serializes unrelated servers and tools into one lineage, creating unnecessary contention

Needs: explicit predecessor source, retry policy, idempotency key, and probably per-server or per-tool chain.

**HIGH: Pairing Map is not equivalent to Hermes file-backed pairing for multi-user deployments**

Risks:
- Restart drops all pairings — availability problem in containerized deployments
- Multiple gateway instances cannot share pairing state
- A paired agent may hit a different instance and be rejected
- Failed attempt counters can be bypassed by restarting the process
- No cleanup behavior specified for expired entries
- `isPaired(agentId)` does not distinguish "verified pairing" from "pending generated code"

Acceptable only if Phase 6 explicitly documents single-process gateway support.

**HIGH: Pairing route security is incomplete**

`POST /pair` accepts `{ agent_id, code }` but MCP middleware extracts `X-Agent-ID`. No proof that the client presenting `X-Agent-ID` is the same actor who paired.

Also:
- `X-Agent-ID` can be spoofed unless bound to Bearer auth, mTLS, signed requests, or a pairing session token
- `/pair` appears unauthenticated — brute-forceable without rate limiting
- Implementation notes describe plain SHA-256 comparison, not constant-time comparison

**MEDIUM: Messaging gateway needs idempotency and replay handling**

Telegram and Discord both can redeliver messages/interactions. No deduplication plan.

Risks:
- Telegram retry or offset bugs can spawn duplicate tasks
- Discord interaction retries can spawn duplicate tasks
- Long-poll crash after dispatch but before offset advancement can duplicate work
- No idempotency key included in `task_spawned`

The graph should record source event IDs (Telegram `update_id`, Discord `interaction.id`) and enforce idempotent dispatch.

**MEDIUM: Discord signature verification is mentioned but not acceptance-tested**

The implementation notes correctly mention Discord HMAC/Ed25519 signature verification using `DISCORD_PUBLIC_KEY`, but the acceptance criteria only test webhook POST. Without hard acceptance criteria, anyone who can reach the interaction endpoint can spawn tasks.

**MEDIUM: Messaging session map risks are not addressed**

Originating chat routing ("notify to originating chat") relies on process-memory session map. Risks:
- In-memory session routing loses notification destinations on restart
- Multi-instance gateway-bot deployments cannot route reliably
- Cross-user leakage possible if session keys collide
- Long-running tasks may finish after session map has expired

The originating session should be persisted into graph events as part of `task_spawned`.

**MEDIUM: MCP external tool registration needs name and trust boundaries**

`graph::mcp-ext::<serverHost>::<toolName>` can collide or contain invalid characters. Tool descriptions and schemas from external servers are untrusted input. Prompt injection through external tool descriptions is a real risk.

**MEDIUM: `execute_bash` should record denied attempts**

For auditability, hardline and dangerous denials should also be graph events (`command_rejected`) with `{ source: 'execute_bash', status: 'blocked', tier, reason }`. Otherwise the audit trail misses security-relevant intent.

**LOW: UserProfileWorker query likely has entity/scope ambiguity**

The query filters `entity_id = userId`, but Crystals across task scopes may not use the human user as `entity_id`. This may silently miss relevant data. Should filter by `payload.user_id` or scope lineage.

**LOW: T6 references remain in verification and success criteria**

Task 6 is superseded, but T7 verification step 6 and the Phase 6 success criteria still require `packages/tui` / `graph-tui`. This directly contradicts the locked decision.

### Suggestions
- Change `execute_bash` from raw `exec` to a constrained execution backend: use `execFile`/`spawn`, set fixed `cwd`, scrub environment variables, add blocked-attempt audit writes, enforce timeout and output limits
- Require server-side lineage resolution for `execute_bash` — do not trust caller-supplied `predecessor_hash` blindly
- Define OCC behavior for McpClientWorker: maintain a current chain head per server, retry on OCC conflict after reloading head, include idempotency key per external call
- Replace or constrain the pairing Map: separate pending codes from verified pairings, use `timingSafeEqual`, add cleanup for expired entries, add rate limits to `/pair`, bind paired state to a token or existing Bearer identity
- Persist messaging routing metadata in graph events: `platform`, `chat_id`, `source_message_id`, `source_update_id`/`interaction_id`, `reply_channel`, `user_id`, `task_id`
- Add idempotency tests for Telegram and Discord dispatch
- Promote Discord signature verification into acceptance criteria and tests
- Remove all T6 verification and success criteria references; replace with: "No TUI package is created; graph visualization deferred to MemexShell Dashboard."

### Risk Assessment
**Overall: HIGH**

The phase expands the runtime from internal graph workers into externally reachable surfaces: MCP clients, messaging gateways, command execution, and multi-user pairing. That changes the threat model substantially.

1. `execute_bash` — once enabled, remote command execution protected mainly by CommandGate and shared auth
2. Causal correctness — MCP and messaging integrations create events outside normal task scope flow; OCC predecessor handling must be precise
3. Pairing state — in-memory Map fine for prototype, not for stated goal of secure multi-user deployments unless explicitly scoped to single-process

---

## Consensus Summary

### Agreed Strengths (2/2 reviewers)
- `EXECUTE_BASH_ENABLED=false` default is the correct baseline
- CommandGate before execution is the right ordering
- External MCP calls as graph events preserves causal auditability
- T6 supersession is the right call — avoids MemexShell conflict
- Agent pairing as a layered addition (not replacing Bearer) is sound

### Agreed Concerns

| Concern | Gemini | Codex | Severity |
|---|---|---|---|
| `execute_bash` sandbox gap — regex-only containment insufficient | HIGH | HIGH | **HIGH** |
| OCC predecessor chain unspecified in McpClientWorker | MEDIUM | HIGH | **HIGH** |
| Messaging gateway idempotency missing | MEDIUM | MEDIUM | **MEDIUM** |
| In-memory pairing lost on restart | LOW | HIGH | **MEDIUM** (depends on multi-instance intent) |
| T6 references remain in T7/success criteria | — | LOW | **LOW** (easy fix) |

### Divergent Views

- **Integration scope vs calling scope (T1)**: Gemini says tool results should go back to the *calling scope* (agent visibility). Codex says use per-server/per-tool chains within the integration scope. Worth investigating: is the integration scope consulted during context assembly? If not, Gemini's concern is valid.
- **execute_bash remediation**: Gemini recommends chroot/nsenter; Codex recommends execFile + env scrubbing + fixed cwd + allowlist. Both agree Docker can be deferred if compensating controls are in place.
- **Pairing persistence**: Codex rates this HIGH (operational risk in multi-process); Gemini rates it LOW (acceptable prototype). Depends on intended deployment model.

### Top 3 Shared Concerns for Planning

1. **execute_bash sandbox** — add fixed `cwd`, env scrubbing, blocked-attempt audit events, and explicit docs on what "CommandGate only" means for the threat model
2. **McpClientWorker predecessor tracking** — define per-server chain head, retry-on-conflict behavior, and idempotency key; clarify whether integration scope is visible in calling context assembly
3. **Messaging idempotency** — persist `source_update_id`/`interaction_id` in `task_spawned` payload; Discord signature verification must be an acceptance criterion, not just an implementation note
