---
status: testing
phase: 04-external-integrations
source:
  - .harness/phases/04-external-integrations/04-PLAN.md
started: 2026-06-06T11:18:00.000Z
updated: 2026-06-07T12:40:00.000Z
---

## Tests

### 1. iii-config.yaml structure
expected: |
  `iii-config.yaml` has exactly 7 plugin blocks:
  iii-worker-manager, iii-cron, iii-observability (with sampling_ratio: 0.1),
  iii-queue (adapter: builtin), iii-pubsub (adapter: local),
  iii-state (adapter: kv, path: .iii-state), iii-exec (watch: src/**/*.ts).
  YAML parses without error.
result: pass
note: Verified by reading file directly — all 7 blocks present with correct adapters. sampling_ratio: 0.1 present.

### 2. ConflictResolverWorker — distributed locking
expected: |
  `ConflictResolverWorker` uses `pg_try_advisory_lock(hashtext($1)::bigint)` instead of
  in-process Map. 4 unit tests pass: acquires lock and merges, lock=false skips,
  LLM throw still unlocks in finally, writeGuard called on both payloads.
result: pass
note: packages/workers/src/concrete/conflict-resolver.worker.test.ts — 4/4 pass

### 3. InMemoryShadowAdapter — exported from @graph/shared
expected: |
  `InMemoryShadowAdapter` is importable from `@graph/shared`. 5 test cases pass:
  OCC write intercepted (not forwarded to real pool), SELECT passes through,
  multiple writes accumulate, clear() resets, WITH new_version AS DO NOTHING variant
  also intercepted. 6 tests total in shadow-adapter.test.ts.
result: pass
note: packages/shared/src/shadow-adapter.test.ts — 6/6 pass

### 4. CrystallizeWorker + LessonSaveWorker registered
expected: |
  Both workers registered in packages/workers/src/index.ts:
  `graph::memory::crystallize` (durable:subscriber on graph::scope::closed) and
  `graph::memory::lesson-save`. Both AgentCards inserted (UUIDs 008/009).
  Tests: CrystallizeWorker skips when no episodic records, fires trigger with
  confidence: 0.6 when records exist. LessonSaveWorker creates new lesson
  (confidence=0.5), reinforces existing (Ebbinghaus formula), dedup by fingerprint.
result: pass
note: index.ts lines 33-34 import both workers; lines 244-260 register + trigger. 6/6 worker tests pass.

### 5. Pi extension package structure
expected: |
  `packages/pi-extension/` exists with src/index.ts and src/pi-types.shim.ts.
  package.json contains `"pi": { "extensions": ["./src/index.ts"] }`.
  TypeScript compiles without errors. InMemoryShadowAdapter imported from @graph/shared.
  Extension registers 7 handlers: session_start, session_before_fork, tool_call,
  spawn_task, complete_task, /fork-ext, /fork-end.
result: pass
note: Directory structure confirmed. TS compile clean. package.json pi.extensions entry present.

### 6. CLI help flag
expected: |
  `graph-runtime --help` (or `npx tsx packages/cli/src/index.ts --help`) exits 0
  and prints usage mentioning both "claude-code" and "pi" agent options.
result: pass
note: Output confirmed — "graph-runtime connect", lists claude-code and pi options, exits 0.

### 7. Full test suite
expected: |
  `npm test` from repo root: all unit tests pass. 0 failures.
  Breakdown: packages/shared (13 tests), packages/workers (63 tests),
  src/ integration tests (163 total with 36 skipped integrations requiring real DB).
result: pass
note: 163 passed, 36 skipped, 0 failures. 27 test files pass, 8 skipped.

### 8. CLI Interactive Dry-Run
expected: |
  Run `npx tsx packages/cli/src/index.ts` (no --help flag).
  The @clack/prompts interface appears: intro says "graph-runtime connect",
  a multiselect asks "Which agents to connect?" with two options:
  "Claude Code (MCP)" and "Pi Terminal (extension)".
  Selecting Claude Code and confirming: reports either "already-wired" or
  "installed" without crashing. Exits with code 0.
result: pass
note: |
  Run 1 (Claude Code only): @clack/prompts UI rendered correctly, intro "graph-runtime connect",
  multiselect → selected "Claude Code (MCP)" → "Claude Code: installed (backup:
  C:\Users\Kuraido/.claude.json.bak-1780792973597)" → "Claude Code MCP wired to ~/.claude.json"
  → "Done." Clean exit, no crash.

  Run 2 (both agents selected — found a bug): Claude Code branch reported "already-wired"
  correctly, but Pi Terminal crashed:
    Error: ENOENT: no such file or directory, copyfile
    'D:\D:\Repo\graph-enginerring\packages\pi-extension\src\index.ts' -> '...\extensions\graph-runtime\src\index.ts'
  Root cause: packages/cli/src/connect/pi.ts:42 used `new URL(import.meta.url).pathname`,
  which on Windows yields a POSIX-style leading-slash path (`/D:/Repo/...`). Node's win32
  `dirname`/`join` treat that leading `/` as a drive-relative root, and Windows resolves it
  against the current drive — producing the doubled `D:\D:\...`.
  Fix: replaced `.pathname` with `fileURLToPath(import.meta.url)` (node:url) — normalizes
  correctly per-OS.

  Run 3 (re-run post-fix, both agents selected): Claude Code → "already-wired"; Pi → "Pi:
  installed" → "Pi extension installed at C:\Users\Kuraido\.pi\agent\extensions\graph-runtime"
  → "Done." Verified on disk: src/index.ts, src/pi-types.shim.ts, package.json all copied.
  Clean exit, no crash. Bug confirmed fixed.

## Summary

total: 8
passed: 8
issues: 1 (found live during UAT, fixed same session, re-verified — see Gaps)
pending: 0
skipped: 0

## Gaps

- **[FIXED] Pi Terminal connect crashed with malformed path** (`D:\D:\...`) when selected from
  the interactive multiselect on Windows. Root cause: `new URL(import.meta.url).pathname`
  produces a POSIX-style leading-slash path that Node's win32 path functions mis-resolve as
  drive-relative. Fixed in `packages/cli/src/connect/pi.ts` by switching to `fileURLToPath()`.
  Re-run confirmed the Pi Terminal install now completes end-to-end (files copied,
  package.json written, settings.json wired). Not yet committed.
