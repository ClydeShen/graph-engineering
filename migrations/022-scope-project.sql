-- Migration 022: scope_lineage.project — workspace/project dimension
--
-- CONSOLE-REDESIGN §11.1. Project is an observable "working folder / cwd"
-- dimension RECORDED ON THE SCOPE — NOT a new first-class entity or registry.
-- This keeps the graph SSOT invariant intact (#1): project is a fact stored on
-- the existing scope row, surfaced in the projection layer (Now clusters by it,
-- Workspace groups deliverables by it). NULL = no project (current behavior),
-- so this column is purely additive and back-compatible.
--
-- Scope: this migration is the lightweight, extensible FOUNDATION. The full
-- ROADMAP 22-workspace-project arc (execute_bash cwd detection that POPULATES
-- this column, per-channel LLM provider routing, onboarding folder roots,
-- forest grouping by project, same-name-rebuild identity) builds on it.

ALTER TABLE scope_lineage ADD COLUMN IF NOT EXISTS project TEXT;

-- Partial index: only non-NULL projects participate in grouping queries.
CREATE INDEX IF NOT EXISTS idx_scope_lineage_project
    ON scope_lineage (project)
    WHERE project IS NOT NULL;
