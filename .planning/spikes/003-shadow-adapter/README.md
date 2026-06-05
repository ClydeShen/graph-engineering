---
spike: "003"
name: shadow-adapter
type: standard
validates: "Given occWrite() is called via InMemoryShadowAdapter.proxy, when SQL matches OCC CTE pattern, then write is captured in Map (0 real DB calls), SELECT passes through, clear() destroys all entries"
verdict: VALIDATED
related: ["004"]
tags: [pi-sandbox, rehearsal, occ, write-path]
---

# Spike 003: InMemoryShadowAdapter

## What This Validates

Given the Pi Sandbox rehearsal mode is active, when `occWrite()` or `occWriteIdempotent()` is called via `InMemoryShadowAdapter.proxy`, then:
- OCC writes go to `Map<string, ShadowEntry[]>` — PostgreSQL never receives the INSERT
- SELECT / reads pass through to the real pool
- `clear()` destroys all entries (阅后即焚)
- `NOTIFY` isolation is free — DB trigger only fires on real PostgreSQL INSERTs; shadow writes never touch PostgreSQL

## How to Run

```bash
npx tsx .planning/spikes/003-shadow-adapter/scripts/shadow-adapter.ts
```

## What to Expect

5 tests, all PASS:
1. OCC write → shadow (no real pool call)
2. SELECT → real pool passthrough
3. Multiple writes accumulate in shadow
4. `clear()` destroys all entries
5. DO NOTHING OCC variant also intercepted

## Investigation Trail

**Write detection heuristic:** `sql.trimStart().startsWith('WITH new_version AS')`
- Both `OCC_WRITE_SQL` and `OCC_WRITE_DO_NOTHING_SQL` open with this exact prefix
- Safe: no other query in the codebase uses this prefix
- Param order is deterministic: `[scopeId, entityId, predecessorHash, canonicalText, eventType?]`

**Fake WriteResult:** Shadow returns `{ occ_result: 'won', version_hash: 'shadow::...', event_type }`.
- Shadow session always "wins" — no OCC contention in memory-only universe
- Fake hash uses `shadow::` prefix; easy to filter in Dashboard (虚线黄色)

**NOTIFY isolation is architecturally FREE:**
- `occWrite()` calls `pool.query()` only — no application-level NOTIFY
- NOTIFY fires via PostgreSQL DB TRIGGER on `execution_event_log` INSERT
- Shadow writes never reach PostgreSQL → trigger never fires → real Workers never see shadow events

## Key Decisions for Phase 4

| Decision | Value |
|---|---|
| Interception surface | `pool.query(sql, params)` — single point, matches `occWrite()` call pattern |
| Write detection | `sql.trimStart().startsWith('WITH new_version AS')` |
| Storage | `ShadowEntry[]` array (append-only during session, cleared on /fork-end) |
| ReadPool | Passthrough to real `pool` — reads always see true PostgreSQL state |
| Destroy mechanism | `shadow.clear()` — O(1), no DB cleanup needed |
