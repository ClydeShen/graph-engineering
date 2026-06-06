# Spike 009 — Dead occWrite Export Removal

**Status:** VALIDATED
**Date:** 2026-06-06
**Question:** Is the `occWrite` function exported from `graph-handle.ts` truly dead? If so, delete it.

---

## Finding: Not dead — but wrongly exported

The local `occWrite` in `packages/workers/src/base/graph-handle.ts` (line 72) is called internally by `GraphHandleImpl.write()` (line 54). It is **not** dead in the "unused code" sense.

**However:** it is `export`ed with zero external importers. Grepping the entire codebase for `from.*graph-handle` shows only:
- `lifecycle.ts` — imports `GraphHandle` type
- `subagent.ts` — imports `GraphHandle` type
- `worker.abstract.ts` — imports `GraphHandle` type

No file imports `occWrite` from `graph-handle.ts`. The export is dead.

**API difference vs canonical occWrite in `@shared/occ-write.ts`:**

| | Local (graph-handle.ts) | Canonical (@shared/occ-write.ts) |
|---|---|---|
| Argument | `GraphWriteEvent` (pre-serialized canonical_json_text) | `OccWriteArgs` (raw payload, serializes internally) |
| Serialization | Done by caller | Done by occWrite |
| Used by | `GraphHandleImpl.write()` only | Gateway, all Memory Workers |

The two implementations are NOT interchangeable — they serve different interface levels. The local one is not a DRY violation in logic, only in export surface.

## Fix applied

**Inline the 12-line body directly into `GraphHandleImpl.write()`** (its only caller), and remove the standalone exported function. This:
- Eliminates the dead export
- Reduces indirection (no standalone function with a single caller)
- Keeps the SQL imports that are now used directly in `write()`

## Verification

- `tsc --noEmit` passes
- `vitest run` passes — 0 failures
