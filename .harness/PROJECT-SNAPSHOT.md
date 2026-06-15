# Project Snapshot — MemexOS

> Generated 2026-06-15. Consolidated current-state across tracker / ADR / ROADMAP / docs / memory / code.
> Regenerate when phase position or tracker state changes materially. This is a derived view — sources of truth are linked below.

## 1. Authority map (which source wins)

| Source | Role | Status |
|---|---|---|
| `.harness/ROADMAP.md` | **Phase 7+ sole phase authority** (~860 lines, detailed) | ✅ current |
| `.harness/state.json` | current position pointer | ✅ current |
| `docs/adr/*` (ADR-01..56) | decision records | ✅ current |
| `docs/CONSOLE-REDESIGN.md` | Console design authority (supersedes UI-SPEC) | ✅ current |
| GitHub Issues (`ClydeShen/graph-engineering` #4 board) | tracker | ⚠️ revived 2026-06-14 after Phase-3-era abandonment |
| `.planning/*` | progress ledger (demoted) | auxiliary |
| `~/.claude/.../memory/*` (44 files) | cross-session continuity | ✅ current |
| `docs/guides/*`, `docs/ARCHITECTURE.md`, `docs/TECH_STACK.md` | user/dev docs | ✅ |

**Drift note:** the GitHub tracker was abandoned after Phase ~3; Phases 8–22 were tracked only in ROADMAP. On 2026-06-14 the tracker was partially revived (medium scope): obsolete issues closed, current open/remaining work re-filed. ROADMAP remains the phase authority; tracker holds actionable open work.

## 2. Code reality (phase progress)

| Phase | State |
|---|---|
| 1–16 | ✅ complete (1.0 candidate; 479→682 tests across arcs) |
| 17 mcp-connector-ecosystem | ✅ complete (ADR-50) |
| 18 first-run-experience | ✅ code-complete — **live-host runs remain** |
| 19 console-and-artifacts | ✅ code-complete (ADR-52) — Console-UI superseded by Phase 21 |
| 20 autonomous-assistant | ✅ code-complete (ADR-53) — browser image/live journey remain |
| 21 console-redesign | 🔄 batches 1–12 landed (682 tests); **remaining → GH #27** |
| 22 workspace-project | 🔄 batch 3 partial; **remaining → GH #28** |
| 23 memex-terminal | 🔄 **arc landed** (ADR-57 Pi-embed): `memex chat` launches the Pi-embed MemexTerminal — execute_bash + schedule_task wired, identity layer (theme/header/footer), provider bridge + Gemini agentic fixed (undici.install-survivable fetch shim), TUI polish (graph widget, outcome panel, /graph /memory overlays). **24 commits, epic #25 not closed** — multimodal envelope / artifact model / full X branch remain |
| Post-1.0 | skill hardening (#26), multimodal I/O, host computer-use, Federated Trail Mesh, ACP, SSH backend |

ADRs: through **ADR-57** (file `docs/adr/0066-adr57-memexterminal-pi-embed.md`). Note filename offset: ADR-N lives in file `00(N+9)`.
state.json position: `03-execute` (MemexTerminal arc; 24 commits local on master).

## 3. Tracker — open issues (post-reconciliation 2026-06-14)

| # | Title | Label | Notes |
|---|---|---|---|
| #24 | spike: A/B-validate the emergence loop (做实核心) | on-hold | PARKED — resume on user "freeze-ready" + live LLM |
| #25 | epic: MemexTerminal 补强 (Pi-SDK Claude-Code-like TUI) | on-hold | **arc landed via ADR-57 Pi-embed** (24 commits): `memex chat` TUI, execute_bash + schedule_task, identity layer, Gemini agentic, /graph /memory overlays. Remaining: multimodal envelope, artifact model, send_message, full X branch |
| #26 | icebox(post-1.0): skill hardening | on-hold | future vision; not to implement; downstream of #24 |
| #27 | Phase 21 remaining: console write path + Now art + live verify | needs-review | appendix-A writes security-sensitive |
| #28 | Phase 22 remaining: workspace/project deep integration | needs-review | §9 B-class decisions open |

**Closed 2026-06-14 (obsolete):** #15 (Phase 3 Console — superseded by Phase 19/21), #10 (Phase 4 Pi sandbox — TD-L observe-first/YAGNI).

## 4. Discussed-but-not-implemented (this session's threads → now tracked)

- **Emergence loop A/B validation** → #24. DV = events-to-convergence + convergence guardrail; trap-task apparatus; key finding: `hitRate` is a Proxy Signal (`failure_count` never incremented); permanent artifacts = injection toggle + failure_count path. Memory: `project_emergence_loop_validation.md`.
- **MemexTerminal 补强** → #25 + ROADMAP §23. Five beams + Y (Q first / P seam, lazygit-researched). Memory: `project_memex_terminal_design.md`.
- **Skill hardening vision** → #26 + ROADMAP §Post-1.0. Memory: `project_skill_hardening_vision.md`.
- **Cross-thread insight:** dangling artifact reference = the emergence-softening signal = #24's missing failure path. Three threads share one mechanism (ADR-43 erase / append-only jiu-jitsu).

## 5. Standing live-verification debt (implemented, not live-verified)

- Phase 18–20 live-host runs (WSL2/macOS/Linux install, docker containment inspect, browser image build, tennis-court journey).
- Onboarding+provider: authenticated `/embeddings` round-trip — NVIDIA + BGE-M3 now reachable (doctor 0-fail, supersedes the Console-live-test block).
- MemexTerminal: Gemini 3.5-flash agentic verified live (thought_signature round-trip via fetch shim, 27cee228); NVIDIA qwen agentic verified.
- Policy: `feedback_live_verification_policy` (logic-done vs live-done).

## 6. Uncommitted working tree (at snapshot time)

Clean except harness checkpoint files (committed alongside this snapshot). **24 commits are local-only on `master`** (MemexTerminal arc) — pushed during this sync.
