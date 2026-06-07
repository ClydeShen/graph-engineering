---
name: user-needs-cross-machine-continuity
description: "User works across machines; .continue-here.json is now git-tracked (commit 6741ad5, 2026-06-08) so phase-resume context syncs via git pull — but the conversation transcript and Claude-Code memory system remain local-machine-only"
metadata:
  node_type: memory
  type: project
  originSessionId: 34d8dadb-193c-4b05-9349-b6cfc1eb25a9
---

User stated (2026-06-08) they need some cross-machine continuity ("我暂时需要有一定的跨机同步"), after learning the session-continuity stack was entirely single-machine-bound. **Status: PARTIALLY RESOLVED same day** — option (a) below was implemented and pushed (commit `6741ad5`), and this very file is part of a second mitigation step (mirroring Claude-Code memory entries into this git-tracked `.memobank`).

**What was fixed:**
- `.harness/phases/*/.continue-here.json` was explicitly excluded by `.gitignore` (predates that session) — removed the ignore rule, force-added all 10 existing `.continue-here.json` files, committed as `6741ad5 chore(harness): track .continue-here.json for cross-machine resume`, pushed to `origin/master`. `git pull` on another machine now carries full phase-resume context (`current_state`, `completed_work`, `remaining_work`, `decisions_made`, `next_action`).
- The Claude-Code memory entries written during the 2026-06-07~08 console-architecture spike were copied into this `.memobank` (renamed to match its kebab-case convention, `[[...]]` links retargeted to the new bare-slug `name:` values) and pushed — see [[memex-final-product-is-hermes-like-e2e]], [[console-unifies-to-graph-projection]], [[value-vs-type-change-cost]], [[reanchor-on-original-design-when-drifted]], [[remove-dangling-design-references-yagni]], [[token-budget-design-concluded]]. `.memobank` is git-tracked, so these now sync via `git pull` too.

**What remains genuinely local-only (NOT fixed, cannot be fixed the same way):**
- The conversation transcript (`.jsonl`) still lives under the local user profile (`C:\Users\Kuraido\.claude\projects\...`), tied to Claude Code's per-machine project hash — cannot be git-tracked into this repo.
- The *original* Claude-Code memory directory remains the live, auto-updating store; `.memobank` is now a manually-curated mirror of the project-relevant subset. New memory entries won't appear here automatically — they need to be copied over deliberately (as this session did) for them to cross machines.

**Why this matters:** Between the now-tracked `.continue-here.json` and this `.memobank` mirror, cross-machine resume now covers both "where did the phase leave off" (the former) and "what were the key project-level decisions/lessons" (the latter) — a substantial improvement over the prior "only a one-line `state.json` pointer, nothing else" state.

**How to apply:** When asked to "save this so it's available elsewhere," remember there are now TWO viable channels in this project: `.continue-here.json` (phase-resume state, auto-written by `/context-handover`) and `.memobank` (curated project memory, requires deliberate copy-over from the live Claude-Code memory). Neither is automatic for the memory side — if a future session produces a durable insight worth keeping across machines, mirror it into `.memobank` explicitly, following the naming convention here (kebab-case slugs, `{type}_` filename prefix, bare slug in `name:`).
