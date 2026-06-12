/**
 * hwm.test.ts — HWM persistence (UX-audit U1 regression).
 *
 * The original advanceHwm was UPDATE-only: with no seed row, every boot read
 * HWM 0 and replayed the full event log (including LLM-calling handlers).
 * These tests pin the UPSERT behavior: first advance creates the row, later
 * advances move it forward, stale advances never regress it.
 *
 * DB-gating: requires DATABASE_URL (bus_state from migration 004). Tests skip
 * automatically when DATABASE_URL is absent.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { advanceHwm, readHwm } from './hwm.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const skip = !DATABASE_URL;

let pool: Pool;
const workerId = `hwm-test-${randomUUID().slice(0, 8)}`;

beforeAll(() => {
  if (skip) return;
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  if (skip) return;
  await pool.query(`DELETE FROM bus_state WHERE worker_id = $1`, [workerId]);
  await pool.end();
});

describe.skipIf(skip)('advanceHwm', () => {
  it('creates the row on first advance (U1: UPDATE-only never persisted)', async () => {
    expect(await readHwm(pool, workerId)).toBe(0);
    await advanceHwm(pool, workerId, 42);
    expect(Number(await readHwm(pool, workerId))).toBe(42);
  });

  it('advances forward and never regresses on stale delivery', async () => {
    await advanceHwm(pool, workerId, 100);
    expect(Number(await readHwm(pool, workerId))).toBe(100);
    await advanceHwm(pool, workerId, 7); // duplicate/out-of-order delivery
    expect(Number(await readHwm(pool, workerId))).toBe(100);
  });
});
