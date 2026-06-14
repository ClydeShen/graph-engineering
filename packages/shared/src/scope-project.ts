/**
 * Scope project (working-folder) dimension — CONSOLE-REDESIGN §11.1.
 *
 * `project` is an observable "working folder / cwd" fact RECORDED on the
 * existing scope_lineage row (migration 022), NOT a new first-class entity.
 * It is projection metadata of the same mutable class as scope_lineage.status —
 * surfaced by the Now universe (cluster naming/colour) and Workspace page
 * (deliverables grouped by project). Recording it does not violate append-only
 * (#2): it never writes the immutable execution_event_log, only the lineage
 * row's metadata column.
 *
 * Identity (§11.3 B-class, resolved): the project value is the absolute working
 * folder PATH used as a plain grouping label — no path+ctime identity scheme.
 * Same-name rebuild therefore reuses the same label and re-clusters naturally
 * via graph connectivity, exactly as the design concluded.
 */

import { existsSync } from 'node:fs';
import { sep } from 'node:path';
import { tmpdir } from 'node:os';
import type { Pool } from 'pg';

/**
 * Resolve a project label from an execution cwd. Ephemeral/tmp directories are
 * NOT a project — only a deliberately-configured working folder labels a
 * cluster, so commands running in the default tmp sandbox leave project NULL.
 */
export function projectFromCwd(cwd: string | undefined | null): string | null {
  if (!cwd) return null;
  const t = tmpdir();
  if (cwd === t || cwd.startsWith(t + sep)) return null;
  return cwd;
}

/**
 * Record the project on a scope (first-write-wins). Only sets the column when it
 * is still NULL so the folder a scope FIRST worked in labels its cluster and a
 * later cwd change does not churn the grouping. Best-effort: a missing column
 * (pre-migration-022) is a silent no-op — the projection dimension is simply
 * absent, never an error on the execution path.
 */
export async function recordScopeProject(
  pool: Pool,
  scopeId: string,
  project: string,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE scope_lineage SET project = $2 WHERE scope_id = $1 AND project IS NULL`,
      [scopeId, project],
    );
  } catch {
    // pre-migration-022 (no project column) — dimension absent, not an error
  }
}

/**
 * Bad-path lazy tombstone (CONSOLE-REDESIGN §11.3): a project is "archived" when
 * its working folder no longer exists on disk. This is a PROJECTION-TIME detect
 * — physically deleting a project folder changes ZERO ledger rows (#2); the
 * trail keeps "what once happened", the projection just shows the cluster as
 * archived/unopenable. Intentional deletion is the separate first-class ADR-43
 * `erase` path; this only covers accidental/external removal (orphan metadata).
 * Caches per process — the filesystem rarely changes under a running gateway and
 * this is called per request across many artifacts.
 */
const archivedCache = new Map<string, { at: number; archived: boolean }>();
const ARCHIVED_TTL_MS = 5_000;
export function isProjectArchived(project: string | null | undefined): boolean {
  if (!project) return false;
  const now = Date.now();
  const hit = archivedCache.get(project);
  if (hit && now - hit.at < ARCHIVED_TTL_MS) return hit.archived;
  const archived = !existsSync(project);
  archivedCache.set(project, { at: now, archived });
  return archived;
}

/** Test seam: clear the archived-detection cache between cases. */
export function _resetProjectArchivedCache(): void {
  archivedCache.clear();
}
