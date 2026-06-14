/**
 * Forest + lineage read routes (CONSOLE-REDESIGN §9 / Phase 21-console-redesign)
 * — the data source for the Now "universe". Pure SELECT over scope_lineage,
 * read-only (no DDL, SELECT pool). scope_lineage has one row per scope (far
 * fewer than execution_event_log), so the recursive descendant counts here are
 * cheap.
 *
 *   GET /v1/forest              — root scopes grouped by channel (galaxies, L0/L1)
 *   GET /v1/scopes/:id/lineage  — one task's scope_lineage subtree (the L2 tree)
 *
 * Channel (galaxy) is recovered from the root scope's intent, which gateway-bot
 * writes as 'session:<platform>::<chatId>' (buildSessionKey). Unparseable intent
 * → the 'direct' galaxy (console/CLI-originated work). Graceful: project/cwd is a
 * later dimension (CONSOLE-REDESIGN §11) and does not block this.
 */

import { Hono } from 'hono';
import type { Pool } from 'pg';
import { basename } from 'node:path';
import { isProjectArchived } from '@graph/shared';
import { validateScopeIdParam } from '../middleware/zod-guard.js';

/**
 * Parse the channel (galaxy) from a root scope's intent. gateway-bot writes
 * intent = 'session:<platform>::<chatId>'. Unparseable → 'direct'. Pure +
 * exported for unit testing.
 */
export function channelFromIntent(intent: string | null): string {
  if (!intent) return 'direct';
  const m = /^session:([a-z]+)::/i.exec(intent);
  return m ? m[1]!.toLowerCase() : 'direct';
}

interface ForestTask {
  scope_id: string;
  intent: string | null;
  status: string;
  created_at: string;
  descendants: number;
  /** CONSOLE-REDESIGN §11.1 — working-folder cluster label, null when unset. */
  project: string | null;
}

interface Galaxy {
  channel: string;
  tasks: ForestTask[];
  status_counts: Record<string, number>;
}

/** A project cluster (§11.1) — distinct working folder grouping its roots. */
interface ProjectCluster {
  /** Absolute working-folder path (the stable grouping key / identity label). */
  project: string;
  /** basename(project) — the human-friendly cluster name (§11.1). */
  name: string;
  roots: number;
  /** §11.3 lazy tombstone — folder no longer on disk → archived/unopenable. */
  archived: boolean;
}

type ForestRow = {
  scope_id: string;
  intent: string | null;
  status: string;
  created_at: string;
  descendants: number;
  project: string | null;
};

/**
 * Group root scopes into galaxies by channel (pure + exported for testing).
 */
export function groupIntoGalaxies(rows: ForestRow[]): Galaxy[] {
  const galaxies = new Map<string, Galaxy>();
  for (const row of rows) {
    const channel = channelFromIntent(row.intent);
    let g = galaxies.get(channel);
    if (!g) {
      g = { channel, tasks: [], status_counts: {} };
      galaxies.set(channel, g);
    }
    g.tasks.push(row);
    g.status_counts[row.status] = (g.status_counts[row.status] ?? 0) + 1;
  }
  return [...galaxies.values()];
}

/**
 * Group root scopes into project clusters by working folder (§11.1). archivedFn
 * is injected so the disk-stat (lazy tombstone, §11.3) stays testable. Roots
 * with no project are omitted — they live only in the channel galaxies.
 */
export function groupIntoProjects(
  rows: ForestRow[],
  archivedFn: (project: string) => boolean,
): ProjectCluster[] {
  const byProject = new Map<string, number>();
  for (const row of rows) {
    if (!row.project) continue;
    byProject.set(row.project, (byProject.get(row.project) ?? 0) + 1);
  }
  return [...byProject.entries()].map(([project, roots]) => ({
    project,
    name: basename(project) || project,
    roots,
    archived: archivedFn(project),
  }));
}

export function buildForestRoute(pool: Pool): Hono {
  const app = new Hono();

  app.get('/forest', async (c) => {
    try {
      const res = await pool.query<{
        scope_id: string;
        intent: string | null;
        status: string;
        created_at: string;
        descendants: string;
        project: string | null;
      }>(
        // tree CTE flattens (scope, its root); descendant count per root = tree
        // size − 1. scope_lineage is small enough that this is fine for v1.
        `WITH RECURSIVE tree AS (
           SELECT scope_id, scope_id AS root FROM scope_lineage WHERE parent_scope_id IS NULL
           UNION ALL
           SELECT sl.scope_id, t.root
           FROM scope_lineage sl JOIN tree t ON sl.parent_scope_id = t.scope_id
         )
         SELECT r.scope_id, r.intent, r.status,
                r.created_at::text AS created_at,
                (SELECT COUNT(*) - 1 FROM tree WHERE root = r.scope_id)::text AS descendants,
                r.project
         FROM scope_lineage r
         WHERE r.parent_scope_id IS NULL
         ORDER BY r.created_at DESC`,
      );
      const rows: ForestRow[] = res.rows.map((r) => ({
        scope_id: r.scope_id,
        intent: r.intent,
        status: r.status,
        created_at: r.created_at,
        descendants: Number(r.descendants),
        project: r.project,
      }));
      return c.json({
        galaxies: groupIntoGalaxies(rows),
        projects: groupIntoProjects(rows, isProjectArchived),
        total_roots: rows.length,
      });
    } catch {
      // migration absent / empty system — an empty forest, not an error
      return c.json({ galaxies: [], total_roots: 0 });
    }
  });

  app.get('/scopes/:id/lineage', async (c) => {
    const id = c.req.param('id');
    const invalid = validateScopeIdParam(c, id);
    if (invalid) return invalid;

    const exists = await pool.query(`SELECT 1 FROM scope_lineage WHERE scope_id = $1`, [id]);
    if (exists.rows.length === 0) return c.json({ error: 'scope not found' }, 404);

    const res = await pool.query<{
      scope_id: string;
      parent_scope_id: string | null;
      depth: number;
      intent: string | null;
      status: string;
      created_at: string;
    }>(
      `WITH RECURSIVE subtree AS (
         SELECT scope_id, parent_scope_id, depth, intent, status, created_at
         FROM scope_lineage WHERE scope_id = $1
         UNION ALL
         SELECT sl.scope_id, sl.parent_scope_id, sl.depth, sl.intent, sl.status, sl.created_at
         FROM scope_lineage sl JOIN subtree s ON sl.parent_scope_id = s.scope_id
       )
       SELECT scope_id, parent_scope_id, depth, intent,
              status, created_at::text AS created_at
       FROM subtree ORDER BY depth ASC, created_at ASC`,
      [id],
    );

    return c.json({
      root: id,
      nodes: res.rows.map((r) => ({
        scope_id: r.scope_id,
        parent_scope_id: r.parent_scope_id,
        depth: r.depth,
        intent: r.intent,
        status: r.status,
        created_at: r.created_at,
      })),
    });
  });

  return app;
}
