---
spike: "005"
name: connect-pi
type: standard
validates: "Given graph-runtime connect pi, when run, then Pi extension is installed to ~/.pi/agent/extensions/graph-runtime/, settings.json is patched atomically, and the command is idempotent"
verdict: VALIDATED
related: ["004"]
tags: [connect-cli, pi-sdk, install, idempotent]
---

# Spike 005: connect-pi CLI

## What This Validates

Given `graph-runtime connect pi`:
1. Pi is detected via `existsSync(~/.pi)`
2. Extension files are written to `~/.pi/agent/extensions/graph-runtime/`
3. `~/.pi/agent/settings.json` is patched atomically (backup + rename trick)
4. Existing extensions in settings.json are preserved (additive, not destructive)
5. Already-wired check is idempotent
6. Dry-run mode works without Pi installed

## How to Run

```bash
# Dry-run (no Pi required)
GRAPH_CONNECT_DRY_RUN=1 npx tsx .planning/spikes/005-connect-pi/scripts/connect-pi.ts

# Real install (requires ~/.pi)
npx tsx .planning/spikes/005-connect-pi/scripts/connect-pi.ts
```

## What to Expect

5 tests, all PASS. Dry-run prints what would be installed without touching the filesystem.

## Investigation Trail

**agentmemory Pi adapter is a stub.** `src/cli/connect/pi.ts` in agentmemory just prints manual install instructions. We implement the real automated install.

**Atomic JSON write pattern (from agentmemory `util.ts`):**
```typescript
writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
renameSync(tmp, target);  // atomic on same filesystem
```

**Settings patch is additive:**
```typescript
settings.extensions = [
  ...(existing ?? []).filter(e => !e.includes('graph-runtime')),
  PI_EXT_DIR,  // append our path
];
```

**Idempotent check:** `extensions[].some(e => e.includes('graph-runtime'))` — if already present, return `{ kind: 'already-wired' }` unless `--force`.

**Pi detected at:** `~/.pi` (on Windows: `C:\Users\<user>\.pi`)

**Settings live at:** `~/.pi/agent/settings.json` (same as agentmemory stub)

## Key Decisions for Phase 4

| Decision | Value |
|---|---|
| Install target | `~/.pi/agent/extensions/graph-runtime/` |
| Detection | `existsSync(~/.pi)` |
| Settings format | `{ extensions: ["...path..."] }` (Pi spec) |
| Idempotent key | `"graph-runtime"` substring in extensions array |
| Atomic write | `renameSync(tmp, target)` — same as agentmemory util.ts |
| Backup | `copyFileSync(settings, settings.bak-timestamp)` before patch |
| Phase 4 implementation | `packages/cli/src/connect/pi.ts` (real version of this spike) |
