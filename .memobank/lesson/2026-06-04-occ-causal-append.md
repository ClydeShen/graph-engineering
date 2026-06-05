---
name: occ-causal-append
description: OCC conflict resolution is now append-only (ADR 41) — DO UPDATE was wrong; losers get a new row, winner is never mutated
metadata:
  type: project
---

OCC Writable CTE changed from causal inversion (DO UPDATE overwrites winner's row with conflict_detected data) to causal append (DO NOTHING preserves winner; losing writer inserts a NEW conflict_detected row whose predecessor points at winner's version_hash). Winner row is immutable post-insert.

`OCC_WRITE_SQL` and `OCC_WRITE_DO_NOTHING_SQL` are now functions accepting a partition table name string. `partitionTable(scopeId)` generates the per-scope partition name. INSERT targets the partition directly (not the parent table) because PostgreSQL ON CONFLICT column-list resolution requires the unique constraint on the target table.

**Why:** DO UPDATE violated the append-only invariant — it mutated an existing row, breaking the hash chain integrity. ADR 41 codified the correct pattern.

**How to apply:** Always call `OCC_WRITE_SQL(partitionTable(scopeId))` — never the old string constant form.
