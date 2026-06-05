/**
 * nesting.test.ts — Control Plane sub-scope creation + sub_scope_resolved injection
 *
 * Covers GATE4-3 (Control Plane half):
 *   (a) createSubScope creates a child with parent_scope_id set and depth+1
 *   (b) createSubScope at depth > MAX_CHILD_SCOPE_DEPTH throws
 *   (c) resolveSubScope on child-with-parent writes one sub_scope_resolved row to parent partition
 *   (d) resolveSubScope on root scope writes zero rows
 *
 * DB-gating: cases (a), (c), (d) require a real PostgreSQL database with
 * migrations 001-005 applied. Set DATABASE_URL to run. Tests skip automatically
 * when DATABASE_URL is absent.
 *
 * @see ADR 23 — nested scope propagation + sub_scope_resolved
 * @see ADR 12 — EVENT_TYPES enum stays at five members
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { MAX_CHILD_SCOPE_DEPTH } from '@graph/shared';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

let pool: Pool;
let ddlPool: Pool;

beforeAll(async () => {
  if (skip) return;
  pool = new Pool({ connectionString: DATABASE_URL });
  ddlPool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  if (skip) return;
  await pool.end();
  await ddlPool.end();
});

// ── (a) createSubScope creates child with parent_scope_id set and depth+1 ────

it.skipIf(skip)(
  '(a) createSubScope creates a child scope with parent_scope_id set and depth = parentDepth+1',
  async () => {
    const { nestScope, createSubScope } = await import('./nesting.js');

    // Create a root scope (depth 0)
    const root = await nestScope(ddlPool, 'root scope for nesting test (a)');

    // Create a child scope at depth 1
    const triggerTaskId = randomUUID();
    const child = await createSubScope(
      ddlPool,
      'child scope for nesting test (a)',
      root.scopeId,
      triggerTaskId,
      1,
    );

    expect(child.scopeId).toBeTruthy();
    expect(child.planHash).toBeTruthy();

    // Verify scope_lineage row has parent_scope_id and depth = 1
    const { rows } = await pool.query<{
      parent_scope_id: string;
      depth: number;
    }>(
      `SELECT parent_scope_id, depth FROM scope_lineage WHERE scope_id = $1`,
      [child.scopeId],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.parent_scope_id).toBe(root.scopeId);
    expect(rows[0]?.depth).toBe(1);
  },
);

// ── (b) createSubScope at depth > MAX_CHILD_SCOPE_DEPTH throws ───────────────

it('(b) createSubScope throws when depth exceeds MAX_CHILD_SCOPE_DEPTH', async () => {
  const { createSubScope } = await import('./nesting.js');

  // depth = MAX_CHILD_SCOPE_DEPTH + 1 must throw without touching the DB
  await expect(
    createSubScope(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any, // ddlPool not needed — throws before first DB call
      'over-depth intent',
      randomUUID(),
      randomUUID(),
      MAX_CHILD_SCOPE_DEPTH + 1,
    ),
  ).rejects.toThrow(/MAX_CHILD_SCOPE_DEPTH/);
});

// ── (c) resolveSubScope on child-with-parent writes one sub_scope_resolved row

it.skipIf(skip)(
  '(c) resolveSubScope on a child scope writes one sub_scope_resolved row to parent partition',
  async () => {
    const { nestScope, createSubScope, resolveSubScope } = await import('./nesting.js');

    // Bootstrap parent scope
    const parent = await nestScope(ddlPool, 'parent scope for resolveSubScope test (c)');

    // Bootstrap child scope
    const triggerTaskId = randomUUID();
    const child = await createSubScope(
      ddlPool,
      'child scope for resolveSubScope test (c)',
      parent.scopeId,
      triggerTaskId,
      1,
    );

    // Write a memory_updated event to child so it has a non-null tail version_hash
    const childEntityId = randomUUID();
    await pool.query(
      `INSERT INTO execution_event_log
         (scope_id, entity_id, event_type, predecessor_hash, version_hash, payload, status)
       VALUES (
         $1::uuid, $2::uuid, 'memory_updated', $3,
         encode(digest($1||'|'||$2||'|'||$3||'|memory_updated|{}','sha256'),'hex'),
         '{}', 'terminated'
       )`,
      [child.scopeId, childEntityId, child.planHash],
    );

    // Call resolveSubScope — should write one sub_scope_resolved to parent
    await resolveSubScope(pool, child.scopeId, triggerTaskId);

    const { rows } = await pool.query<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, payload FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'sub_scope_resolved'`,
      [parent.scopeId],
    );

    expect(rows.length).toBe(1);
    expect(rows[0]?.event_type).toBe('sub_scope_resolved');

    const payload = rows[0]?.payload ?? {};
    expect(payload).toHaveProperty('child_scope_id', child.scopeId);
    expect(payload).toHaveProperty('trigger_task_id', triggerTaskId);
    expect(payload).toHaveProperty('child_final_version_hash');
    expect(payload).toHaveProperty('parent_scope_id', parent.scopeId);
  },
);

// ── (d) resolveSubScope on root scope writes zero rows ───────────────────────

it.skipIf(skip)(
  '(d) resolveSubScope on a root scope (no parent) writes zero rows',
  async () => {
    const { nestScope, resolveSubScope } = await import('./nesting.js');

    // Root scope has no parent
    const root = await nestScope(ddlPool, 'root scope for resolveSubScope no-op test (d)');
    const triggerTaskId = randomUUID();

    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'sub_scope_resolved'`,
      [root.scopeId],
    );

    await resolveSubScope(pool, root.scopeId, triggerTaskId);

    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM execution_event_log
       WHERE scope_id = $1 AND event_type = 'sub_scope_resolved'`,
      [root.scopeId],
    );

    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    expect(Number(after.rows[0]?.count)).toBe(0);
  },
);
