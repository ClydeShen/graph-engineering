# Console Trail-Mesh Visualization — Design Plan

> Status: **proposal (not yet implemented)** · 2026-06-15
> Motivation: `/now` shows only scope-level hub-and-spoke (galaxies = channels,
> sessions as dots), so it "doesn't feel like a growing graph." This plan adds the
> missing layer — the **event-level associative trail mesh** — which is the actual
> Memex vision (Bush's associative trails).

## 1. Why it doesn't feel like a graph today

Current `/now` rendering chain:

| Layer | Component | Endpoint | What it shows |
|---|---|---|---|
| L0/L1 | `UniverseCanvas` | `GET /v1/forest` | galaxies (channels) + root scopes as dots |
| L2 | `ForestCanvas` | `GET /v1/scopes/:id/lineage` | a scope's **child-scope** subtree (depth ≤ 3) |

Two consequences (both confirmed in code):

1. **Only scopes are nodes — never events.** The rich within-session trail
   (`user → assistant → tool → tool → assistant`, branching entities) is never
   drawn. A terminal session has **no child scopes**, so `ForestCanvas` renders a
   single node → the "one big node accumulating sessions" you saw.
2. **The event-mesh endpoint already exists but is orphaned.** `GET
   /v1/scopes/:id/topology` (`topology.ts`) returns `nodes` = events
   (`version_hash`, `entity_id`, `event_type`) and `edges` = the `predecessor_hash`
   causal chain. `api.topology()` is defined in the console client — but **no
   canvas calls it**. The old `/topology` page now renders `ForestCanvas`
   (lineage), not this.

So ~50% of "treat it as a graph" is already built; it just isn't wired or enriched.

## 2. What "graph feel" means, concretely

Three edge families make a mesh (vs a tree/hub):

- **Causal trail** (within a scope): `predecessor_hash → version_hash`. Already in
  `topology.ts`. This is the spine.
- **Entity recurrence** (the associative part): the same `entity_id` touched by
  multiple events = a re-visited "item" (Bush's trail re-entry). Derivable from
  `execution_event_log.entity_id`. Not currently drawn.
- **Cross-scope links**: parent→child scope (`scope_lineage.parent_scope_id`,
  exists) and **lesson → source scope** (crystallized `procedural_memory` linking
  back to the trail that produced it). The lesson→scope link needs a stored or
  derivable origin (see §6 open question).

Node kinds come from **`payload.kind`, not `event_type`** — `event_type` is coarse
(`plan_created / task_spawned / memory_updated / conflict_detected / scope_closed /
sub_scope_resolved`); almost everything is `memory_updated`, with the real kind in
`payload.kind` (`conversation.user`, `conversation.assistant`, tool runs, lessons).
Reuse the existing `classifyEvent()` logic (terminal-pi/graph-snapshot) to bucket:
`user · assistant · tool · memory · lesson · sub-scope · conflict`.

## 3. Target views (layered drill, not a replacement)

Keep the universe; add depth beneath it.

```
L0  galaxies (channels)              ← UniverseCanvas  (keep)
L1  root scopes per galaxy           ← UniverseCanvas  (keep)
L2  scope's trail MESH (NEW)         ← TrailCanvas  → GET /v1/scopes/:id/topology (enriched)
        nodes: events by kind (colored), sized by ?
        edges: causal chain (solid) + entity recurrence (dashed)
L3  cross-scope associations (NEW, later) ← lessons ↔ source scopes, entity reuse across scopes
```

The current L2 (child-scope lineage tree) stays available as a toggle — it's
useful for multi-scope tasks — but for a terminal session the default L2 becomes
the **event trail mesh**, which is where the "growing graph" actually lives.

## 4. Node / edge encoding (react-force-graph-2d, already in use)

Nodes (by `payload.kind` → semantic color, reuse Observatory tokens):
- `user` brass · `assistant` parchment · `tool` run-green · `lesson` indigo ·
  `memory` muted · `conflict` rust · `sub-scope` dim.
- size: small constant; the newest event pulses (ties into existing SSE pulse).
- label on hover: kind + first line of `payload.text`/`command` (reuse `firstLine`).

Edges:
- **causal** (predecessor → version): solid, dim. The spine.
- **entity recurrence**: when N events share an `entity_id`, link them in order
  with a dashed, lower-opacity edge — visually "this item was revisited."

## 5. Endpoints

- **Reuse** `GET /v1/scopes/:id/topology` — already returns nodes+edges, 500-cap,
  `truncated` flag. **Enrich** it: add `kind` (from `payload.kind` via
  `classifyEvent`) and a short `label` per node, so the client doesn't re-fetch
  payloads. (~15 lines, additive, no schema change.)
- **New (L3, later)** `GET /v1/scopes/:id/associations` — cross-scope edges:
  entity_ids in this scope that also appear in other scopes, + lessons whose
  origin is this scope. Bounded, opt-in (a toggle, not default).

## 6. Open questions / decisions

1. **Lesson → source-scope link**: ✅ RESOLVED — `procedural_memory.scope_id`
   already exists (indexed, migration 003). Lessons record their origin scope, so
   L3 lesson↔scope edges are feasible with no schema change.
2. **2D vs 3D**: `/now` universe is react-force-graph-**3d** (ThreeJS); `topology`
   client type implies 2d. Recommend **2d for the trail mesh** (denser, more
   legible for causal chains; 3d is nice for the galaxy scatter but harder to read
   a chain). Mixed is fine (different canvases).
3. **Default L2**: for sessions with no child scopes (terminal), default to the
   event mesh; for multi-scope tasks, default to the lineage tree, with a toggle.
   Or always offer both via a tab. **Recommend: a toggle, default = mesh.**

## 7. Phasing (each independently shippable)

- **P1 — wire the existing topology endpoint into a `TrailCanvas`** (L2 event
  mesh, causal edges only, kind colors). Biggest "it's a graph now" payoff for the
  least work; uses an endpoint that already exists. ~½ day.
- **P2 — enrich**: `kind`+`label` on `/topology`, entity-recurrence edges, hover
  cards, newest-node pulse via the existing Now SSE. ~½ day.
- **P3 — cross-scope associations** (`/associations`, lessons↔scopes, entity reuse
  across scopes): the true "mesh across time." Depends on the §6.1 schema check.

## 8. Non-goals

- Not replacing the galaxy universe (it's the right L0/L1).
- Not editing the graph from the console (read-only projection, per the existing
  "observable ≠ operable" stance).
- Not changing the write model / event schema (P1–P2 are pure read projections).
