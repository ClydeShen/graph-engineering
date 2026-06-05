---
name: project-snapshot
description: Creates a comprehensive synchronized snapshot of project state — aligning code implementation with design docs (ADRs, open question tracker), cleaning implementation-notes, removing stale docs and memories, syncing GitHub issues/milestones/board, and updating README and memory. Use when: after a phase completes, before planning the next phase, when docs feel stale, or for periodic project health checks. Consumes 20–40% of a context window. Run `/setup-harness-skills` if GitHub config is missing from `.claude/harness.json`.
---

# Project Snapshot

Finds and repairs fact deltas across all project layers: code → docs → GitHub → memory. Does NOT do code review, architectural decisions, or quality improvements. Every edit must trace to an observable fact in the codebase.

## Core principle

**"Fact delta only, git status drives the scan."**

Start from `git status` (modified + untracked files), not a full directory crawl. Three types of fact delta:

| Type | Example | Action |
|---|---|---|
| **Interface mismatch** | ADR says `complete()`, code uses `chat()` | Edit ADR |
| **Status stale** | Tracker shows 🔴, code confirms fix | Update to ✅ with file:line evidence |
| **External not synced** | Endpoint implemented, issue has no comment | Add GitHub progress comment |

---

## Workflow

### Phase 1 — ORIENT

- [ ] Read `.harness/state.json` → current phase, last stopped position
- [ ] Read `.claude/harness.json` → GitHub `owner`, `repo`, `project_v2_id` (catch typos — repo name in remote URL often differs from folder name)
- [ ] `git log --oneline -15` → confirm committed baseline
- [ ] `git status` → identify `M` (modified) and `??` (untracked) files — **this list drives all subsequent reads**

### Phase 2 — CODE DELTA

- [ ] **Parallel-read** all `M` and `??` files in `packages/` or `src/` (batch by independence, not sequentially)
- [ ] Run `roam_health` → structural score, cycles, god components
  - Index stale (>24h): note, continue with manual reads — health score still valid
  - `roam_dead_code` timeout: skip, note in output
- [ ] Ask: *"What new capabilities are implemented that docs don't yet know about?"*

Parallel batch example:
```
Batch A: roam_health + github_list_issues + git_log (independent)
Batch B: Read file-1 + Read file-2 + Read file-3 (independent)
Batch C: Edit doc-A + Edit tracker + GitHub comment (independent writes)
```

### Phase 3 — DOC SYNC

#### 3a. ADR cross-reference

For each ADR referenced by changed files:
- [ ] Compare ADR interface/schema definitions against actual code (method names, return types, package locations)
- [ ] Edit only factually incorrect fields — do NOT rewrite prose or restructure sections
- [ ] Use sufficiently long `old_string` to ensure unique match

#### 3b. Open question tracker

Find the project's open question tracker (e.g. `docs/未决问题追踪.md`, `docs/OPEN-QUESTIONS.md`):
- [ ] For each 🔴 / 🟡 item: check if the code resolves it
- [ ] Update status to ✅ where resolved — add evidence: `file.ts:line_number` confirms
- [ ] Update footer counts

#### 3c. Implementation notes cleanup

Find `.harness/phases/*/implementation-notes.md` or similar:
- [ ] Remove entries for resolved items (already documented in ADRs or closed issues)
- [ ] Keep entries for active deviations from spec that are not yet in any ADR
- [ ] If file becomes empty after cleanup: note it, do not delete without user confirmation

#### 3d. Stale document detection

```
Glob docs/**/*.md
```
- [ ] For each doc: is it referenced from CLAUDE.md, any ADR, any open issue, or any harness file?
- [ ] If unreferenced AND content is superseded: **list it in output, do NOT delete** — user confirms

### Phase 4 — MEMORY SYNC

Read `.memobank/MEMORY.md` (or equivalent memory index):
- [ ] For each memory referencing a file path: `Glob` to verify it still exists
- [ ] For each memory referencing a function/symbol: `Grep` to verify it still exists
- [ ] For each memory referencing a GitHub issue number: verify issue is still open/relevant
- [ ] Stale memory (file deleted, symbol renamed, issue closed): **propose deletion, list in output — do NOT delete**
- [ ] New decisions from this session worth preserving: write as `project` or `feedback` memory type

### Phase 5 — GITHUB SYNC

Requires `.claude/harness.json` with `github.owner`, `github.repo`, `github.project_v2_id`.

#### 5a. Open issues review

```
mcp__github__list_issues (state: OPEN, perPage: 50)
```

For each open issue:
- **Acceptance criteria satisfied by code**: comment with evidence → propose closing (do NOT auto-close)
- **Partially satisfied**: comment with what's done + what remains
- **No change**: skip

Check for new capabilities without a tracking issue — propose creating one (do not create without user approval).

#### 5b. Milestones

- [ ] Check active milestone: does its description still match the current phase scope?
- [ ] If phase scope changed (e.g. ADR 42 added to Phase 3): update milestone description

#### 5c. Board field sync

For issues whose status changed this session:
```bash
# Fetch node ID
gh issue view N --json id --jq '.id'
# Then updateProjectV2ItemFieldValue via GraphQL
```

Map: uncommitted implementation → `in_progress`; committed + verified → `done`

Every GitHub comment must end with:
```
🤖 Posted by `/project-snapshot` (AI-generated)
```

### Phase 6 — README UPDATE

- [ ] Read `README.md` (or `packages/*/README.md`)
- [ ] Check: phase status, capabilities list, API endpoints, setup instructions
- [ ] Update only factually stale sections — do NOT add new sections without user instruction
- [ ] Skip if README has no phase/capability references

### Phase 7 — CROSS-CHECK

Before finishing, list everything:

```
## Snapshot report — YYYY-MM-DD

### Doc changes (N files)
- ADR 22: updated LLMProvider.chat() method name (was complete())
- 未决问题追踪: P0-E ✅ (watchdog.ts:200 confirmed)

### GitHub syncs (N actions)
- Issue #15: progress comment (2/4 Gate 2 endpoints implemented)

### Memory changes (N actions)
- Stale: feedback_llm_provider.md references deleted function `complete()` — proposed deletion

### Skipped (require user confirmation)
- docs/old-spec.md: unreferenced, content superseded by ADR 24
- .memobank/feedback_X.md: stale, proposed deletion

### Commit
docs: project-snapshot sync YYYY-MM-DD
```

Commit all doc edits in a single commit with the above format.

---

## Tool degradation rules

| Preferred | Fallback when it fails |
|---|---|
| `roam_health` | Note stale/failed; continue — health score is still valid even with stale index |
| `roam_dead_code` | Skip (expensive, times out on large repos); note in output |
| `mcp__github__list_issues` | Check `.claude/harness.json` repo name — common source of 404 (folder name ≠ GitHub repo name) |
| `roam index --force` (background) | Run in background, proceed without blocking on it |

## What this skill does NOT do

- Code review or quality improvements
- Architectural decisions or design work
- Auto-closing issues
- Deleting files or memories without user confirmation
- Committing application code (only doc/harness changes)
- Opening PRs
