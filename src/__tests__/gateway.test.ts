/**
 * Unit tests for the HTTP Gateway — 400 validation paths.
 *
 * All tests use Hono's built-in test client (app.request()) and a no-op spy pool.
 * The DB is NEVER accessed on 400 paths — this is asserted per test.
 *
 * @see ADR 24 — Zod/Regex iron gate: 400 before any DB touch
 * @see REQ-16 — Zod validation UUID v4 + hash regex
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { buildApp } from '../../packages/gateway/src/index.js';

// ── Spy pool — tracks whether query() was called ─────────────────────────────

function makeSpyPool() {
  const spy = vi.fn();
  return {
    pool: { query: spy } as unknown as Pool,
    spy,
  };
}

// Valid test fixtures
const VALID_SCOPE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_ENTITY_UUID = '6ba7b810-9dad-41d0-80b4-00c04fd430c8';
const VALID_HASH = 'a'.repeat(64);

// ── POST /v1/scopes ───────────────────────────────────────────────────────────

describe('POST /v1/scopes', () => {
  it('returns 400 and does not call DB when intent is empty', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const res = await app.request('/v1/scopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent: '' }),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 and does not call DB when intent is missing', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const res = await app.request('/v1/scopes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── POST /v1/scopes/:id/events — scope UUID validation ───────────────────────

describe('POST /v1/scopes/:id/events — scope UUID param validation', () => {
  it('returns 400 when :id is not a valid UUID v4 and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const body = {
      event_type: 'task_spawned',
      entity_id: VALID_ENTITY_UUID,
      predecessor_hash: VALID_HASH,
      payload: { task: 'test' },
    };

    const res = await app.request('/v1/scopes/not-a-uuid/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 when :id is a UUID v1 (wrong version) and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    // UUID v1 — note the '1' in position 14 (version nibble)
    const uuidV1 = '550e8400-e29b-11d4-a716-446655440000';

    const body = {
      event_type: 'task_spawned',
      entity_id: VALID_ENTITY_UUID,
      predecessor_hash: VALID_HASH,
      payload: { task: 'test' },
    };

    const res = await app.request(`/v1/scopes/${uuidV1}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── POST /v1/scopes/:id/events — body validation ─────────────────────────────

describe('POST /v1/scopes/:id/events — body validation', () => {
  it('returns 400 when predecessor_hash is not 64 hex chars and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const body = {
      event_type: 'task_spawned',
      entity_id: VALID_ENTITY_UUID,
      predecessor_hash: 'tooshort',  // invalid — not 64 hex chars
      payload: { task: 'test' },
    };

    const res = await app.request(`/v1/scopes/${VALID_SCOPE_UUID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 when predecessor_hash contains uppercase hex chars and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    // 64 chars but uppercase — HASH_HEX64 requires lowercase /^[0-9a-f]{64}$/
    const upperHash = 'A'.repeat(64);

    const body = {
      event_type: 'task_spawned',
      entity_id: VALID_ENTITY_UUID,
      predecessor_hash: upperHash,
      payload: { task: 'test' },
    };

    const res = await app.request(`/v1/scopes/${VALID_SCOPE_UUID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 when entity_id is not a valid UUID and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const body = {
      event_type: 'task_spawned',
      entity_id: 'not-a-uuid',
      predecessor_hash: VALID_HASH,
      payload: { task: 'test' },
    };

    const res = await app.request(`/v1/scopes/${VALID_SCOPE_UUID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 when event_type is plan_created (infrastructure-only event) and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const body = {
      event_type: 'plan_created',  // not in EventBodySchema enum
      entity_id: VALID_ENTITY_UUID,
      predecessor_hash: VALID_HASH,
      payload: { task: 'test' },
    };

    const res = await app.request(`/v1/scopes/${VALID_SCOPE_UUID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('returns 400 when event_type is scope_closed (infrastructure-only event) and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const body = {
      event_type: 'scope_closed',  // not in EventBodySchema enum
      entity_id: VALID_ENTITY_UUID,
      predecessor_hash: VALID_HASH,
      payload: { task: 'test' },
    };

    const res = await app.request(`/v1/scopes/${VALID_SCOPE_UUID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── GET /v1/scopes/:id — UUID validation ─────────────────────────────────────

describe('GET /v1/scopes/:id — UUID param validation', () => {
  it('returns 400 when :id is not a valid UUID v4 and does not call DB', async () => {
    const { pool, spy } = makeSpyPool();
    const app = buildApp(pool, pool, 4096);

    const res = await app.request('/v1/scopes/invalid-id');

    expect(res.status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── Valid request passes the guard ────────────────────────────────────────────

describe('valid event body passes Zod guard (reaches handler)', () => {
  it('a valid POST /v1/scopes/:id/events body proceeds past Zod and reaches DB (spy called)', async () => {
    // The spy pool will throw when actually queried — that is expected.
    // What we test here is that query() IS called (i.e. the Zod guard did not block it).
    const spy = vi.fn().mockRejectedValue(new Error('spy: no real DB'));
    const pool = { query: spy } as unknown as Pool;
    const app = buildApp(pool, pool, 4096);

    const body = {
      event_type: 'task_spawned',
      entity_id: VALID_ENTITY_UUID,
      predecessor_hash: VALID_HASH,
      payload: { task: 'test' },
    };

    // We expect a non-400 response (likely 500 since spy throws)
    const res = await app.request(`/v1/scopes/${VALID_SCOPE_UUID}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    // The key assertion: spy was called — Zod guard let the request through
    expect(spy).toHaveBeenCalled();
    // Status should be non-400 (handler was reached)
    expect(res.status).not.toBe(400);
  });
});
