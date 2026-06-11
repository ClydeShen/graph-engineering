import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Pool } from 'pg';
import {
  generatePairingCode,
  verifyPairingCode,
  markPaired,
  isPaired,
  configurePairingPersistence,
  warmPairingCache,
  TTL_SECONDS,
  MAX_FAILED_ATTEMPTS,
  GENERATION_RATE_LIMIT_MS,
  _resetStoreForTest,
} from './pairing.js';

/** Assert the success branch of generatePairingCode. */
function mustGenerate(agentId: string): { code: string; expiresAt: number } {
  const result = generatePairingCode(agentId);
  if ('error' in result) throw new Error(`unexpected rate limit: ${result.error}`);
  return result;
}

describe('agent pairing', () => {
  beforeEach(() => {
    _resetStoreForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates an 8-char code from the unambiguous alphabet (no 0/O/1/I)', () => {
    const { code, expiresAt } = mustGenerate('agent-gen');
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(code).not.toMatch(/[0O1I]/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns { ok: true } for the correct code', () => {
    const { code } = mustGenerate('agent-ok');
    expect(verifyPairingCode('agent-ok', code)).toEqual({ ok: true });
  });

  it('returns reason: invalid for a wrong code', () => {
    mustGenerate('agent-wrong');
    expect(verifyPairingCode('agent-wrong', 'WRONGCOD')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('returns reason: locked after MAX_FAILED_ATTEMPTS wrong guesses', () => {
    mustGenerate('agent-lock');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      verifyPairingCode('agent-lock', 'XXXXXXXX');
    }
    expect(verifyPairingCode('agent-lock', 'XXXXXXXX')).toEqual({ ok: false, reason: 'locked' });
  });

  it('returns reason: expired when TTL has elapsed', () => {
    vi.useFakeTimers();
    mustGenerate('agent-exp');
    vi.advanceTimersByTime((TTL_SECONDS + 1) * 1000);
    expect(verifyPairingCode('agent-exp', 'ANYTHNG2')).toEqual({ ok: false, reason: 'expired' });
  });

  it('isPaired returns false before markPaired, true after', () => {
    const { code } = mustGenerate('agent-pair');
    expect(isPaired('agent-pair')).toBe(false);
    verifyPairingCode('agent-pair', code);
    markPaired('agent-pair');
    expect(isPaired('agent-pair')).toBe(true);
  });

  it('isPaired returns false for unknown agent', () => {
    expect(isPaired('nobody')).toBe(false);
  });

  // ── Phase 11 hardening (TD-G) ──────────────────────────────────────────────

  it('rate-limits code generation: second request within 10 min is refused', () => {
    mustGenerate('agent-rl');
    const second = generatePairingCode('agent-rl');
    expect(second).toMatchObject({ error: 'rate_limited' });
    expect((second as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
  });

  it('allows regeneration after the rate-limit window elapses', () => {
    vi.useFakeTimers();
    mustGenerate('agent-rl2');
    vi.advanceTimersByTime(GENERATION_RATE_LIMIT_MS + 1);
    expect('code' in generatePairingCode('agent-rl2')).toBe(true);
  });

  it('paired agents are not rate-limited for new codes (re-pairing path)', () => {
    const { code } = mustGenerate('agent-rp');
    verifyPairingCode('agent-rp', code);
    markPaired('agent-rp');
    expect('code' in generatePairingCode('agent-rp')).toBe(true);
  });

  it('writes through to agent_pairing when persistence is configured', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    configurePairingPersistence({ query } as unknown as Pool);
    mustGenerate('agent-db');
    // persist() is fire-and-forget — flush microtasks
    await new Promise((r) => setTimeout(r, 0));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO agent_pairing'),
      expect.arrayContaining(['agent-db']),
    );
  });

  it('warmPairingCache loads persisted paired state into the hot cache', async () => {
    const now = new Date();
    const pool = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          agent_id: 'agent-warm',
          code_hash: 'h',
          salt: 's',
          created_at: now,
          last_generated_at: now,
          failed_attempts: 0,
          paired: true,
        }],
      }),
    } as unknown as Pool;

    const loaded = await warmPairingCache(pool);
    expect(loaded).toBe(1);
    expect(isPaired('agent-warm')).toBe(true);
  });
});
