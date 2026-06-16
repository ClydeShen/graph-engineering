---
name: project_now_realtime_and_hermes_gap
description: Now-universe realtime fixed (4bb2f8ba, pushed); analysis of the gap from current state to Hermes-like agent = MemexTerminal X-beam (tool exec + approval), 5 concrete steps
metadata:
  type: project
---

2026-06-15 session.

**Now universe realtime — FIXED & pushed (4bb2f8ba).** "必须刷新才看到新节点" had
four layered causes: (1) nestScope committed plan_created with no pg_notify (new
galaxy invisible until first occWrite); (2) stream.ts held a pool client per SSE
conn and never released on disconnect → zombie LISTENs exhausted the pool(max10) →
realtime died for everyone + reads timed out; (3) lossy pulse never reconciled on
reconnect; (4) ROOT browser cause: Next dev BUFFERS rewrite-proxied SSE — EventSource
OPENed but got zero frames (curl worked). Fixes: nestScope pulses; stream.ts → one
shared LISTEN fanned out (SSE never touches pool); use-trail-pulse onOpen reconcile;
NEW `console/app/v1/stream/route.ts` streaming route handler (beats rewrite, injects
token). Browser-verified live-grow.

**Gap analysis: from now → "like Hermes" (autonomous code/email/scheduling).** Key
finding: the agentic MACHINE already exists & is journey-tested — execute_bash
(containerized, ADR-47 approval), ApprovalService, AskUserService (ask_user), 13+ MCP
tools, channels, cron. The Telegram/channel chat is DELIBERATELY conversational
(ADR-54 CONVERSATION_SYSTEM_ROLE, only memex_retrieve tool) — the bot's "I have no
tools" reply is ACCURATE for that path, by design. So the gap is NOT missing
capability; it's the missing human-facing agentic SURFACE = MemexTerminal (#25 /
ROADMAP §23, on-hold, design-locked). The undrilled **X beam** = "where tools execute
/ how approval flows" is the blocker. Steps to Hermes (≈4-5 ctx windows):
1. DRILL X (design, blocks planning): terminal's agentic turn = new agentic gateway
   endpoint (STABLE_SYSTEM_ROLE + MCP tools loop) vs conversation-core "tool mode" gate.
2. Protocol ADR (beam C): unified typed envelope (Anthropic-Messages shape; events
   text_delta/tool_execution_start/approval_required/tool_result).
3. Build agentic turn path (code): gateway tool-loop calling execute_bash etc.;
   approval via existing ApprovalService → approval_required event.
4. Pi-SDK TUI surface (code): readline REPL → chat + status line + inline approval
   interjection (Y's A3). Pi SDK = DRY loop scaffold.
5. (later) multimodal + ProviderProfile capability gating + artifact reference-by-path.
**Verify during X-drill:** does an outbound `send_message(channel)` tool exist? a
"schedule future task" tool? (cron is internal-only, spawn_subtask is immediate) — if
not, add two small tools in step 3, else "email/scheduling" Hermes parity is empty.
Trust rationale: agentic surface = terminal (local operator), NOT channel chat
(random Telegram driving shell = the allowlist-hardening danger). See [[project_memex_terminal_design]].

**Open at session end:** 7807b9e5 (AC3 node art) UNPUSHED (user gates pushes);
offered to drill X-beam — awaiting user yes/no. Console restarted standalone on :3000.
