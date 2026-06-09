import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generatePairingCode,
  verifyPairingCode,
  markPaired,
  isPaired,
  TTL_SECONDS,
  MAX_FAILED_ATTEMPTS,
  _resetStoreForTest,
} from './pairing.js';

describe('agent pairing', () => {
  beforeEach(() => {
    _resetStoreForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generates an 8-char alphanumeric code', () => {
    const { code, expiresAt } = generatePairingCode('agent-gen');
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it('returns { ok: true } for the correct code', () => {
    const { code } = generatePairingCode('agent-ok');
    expect(verifyPairingCode('agent-ok', code)).toEqual({ ok: true });
  });

  it('returns reason: invalid for a wrong code', () => {
    generatePairingCode('agent-wrong');
    expect(verifyPairingCode('agent-wrong', 'WRONGCOD')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('returns reason: locked after MAX_FAILED_ATTEMPTS wrong guesses', () => {
    generatePairingCode('agent-lock');
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      verifyPairingCode('agent-lock', 'XXXXXXXX');
    }
    expect(verifyPairingCode('agent-lock', 'XXXXXXXX')).toEqual({ ok: false, reason: 'locked' });
  });

  it('returns reason: expired when TTL has elapsed', () => {
    vi.useFakeTimers();
    generatePairingCode('agent-exp');
    vi.advanceTimersByTime((TTL_SECONDS + 1) * 1000);
    expect(verifyPairingCode('agent-exp', 'ANYTHNG1')).toEqual({ ok: false, reason: 'expired' });
  });

  it('isPaired returns false before markPaired, true after', () => {
    const { code } = generatePairingCode('agent-pair');
    expect(isPaired('agent-pair')).toBe(false);
    verifyPairingCode('agent-pair', code);
    markPaired('agent-pair');
    expect(isPaired('agent-pair')).toBe(true);
  });

  it('isPaired returns false for unknown agent', () => {
    expect(isPaired('nobody')).toBe(false);
  });
});
