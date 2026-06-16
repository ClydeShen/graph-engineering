---
name: project-user-needs-cross-machine-continuity
description: "User works across machines; .continue-here.json is now git-tracked (commit 6741ad5, 2026-06-08) so phase-resume context syncs via git pull — but the conversation transcript and memory system remain local-machine-only"
metadata: 
  node_type: memory
  type: project
  originSessionId: 34d8dadb-193c-4b05-9349-b6cfc1eb25a9
---

User stated (2026-06-08) they need some cross-machine continuity ("我暂时需要有一定的跨机同步"), after learning the session-continuity stack was entirely single-machine-bound. **Status: PARTIALLY RESOLVED same day** — option (a) below was implemented and pushed (commit `6741ad5`).

**What was fixed:**
- `.harness/phases/*/.continue-here.json` was explicitly excluded by `.gitignore` (predates that session) — removed the ignore rule, force-added all 10 existing `.continue-here.json` files, committed as `6741ad5 chore(harness): track .continue-here.json for cross-machine resume`, pushed to `origin/master`. `git pull` on another machine now carries full phase-resume context (`current_state`, `completed_work`, `remaining_work`, `decisions_made`, `next_action`).

**What remains genuinely local-only (NOT fixed, cannot be fixed the same way):**
- The conversation transcript (`.jsonl`) and the entire memory system (`C:\Users\Kuraido\.claude\projects\...\memory\`) live under the local user profile (`.claude`), entirely outside the git repo. These are tied to Claude Code's per-machine project hash and can't simply be git-tracked into this repo.

**Why this matters:** `/session-start` on another machine can now recover rich phase-resume context (via the now-tracked `.continue-here.json`) — a major improvement over the prior "only a one-line `state.json` pointer" state. But it still cannot recover the actual conversation or memory entries (e.g. [[project_memex_final_product_is_hermes_like_e2e]] won't exist on a fresh machine until re-derived or manually re-saved there).

**How to apply:** `.continue-here.json` cross-machine sync now works — feel free to rely on it and keep it current via `/context-handover`. But still don't imply memory-saves bridge machines: if the user starts fresh on another machine, expect memory to be empty there and rebuild/re-save key facts as they resurface, rather than assuming continuity. If full cross-machine memory sync becomes a real recurring need, that would require a structurally different mechanism (e.g. exporting memory files into the repo itself) — not attempted yet.
