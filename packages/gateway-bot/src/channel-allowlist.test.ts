import { describe, it, expect } from 'vitest';
import { parseAllowlist, isChatAuthorized, allowlistStartupWarning } from './channel-allowlist.js';

describe('parseAllowlist', () => {
  it('splits, trims, and drops empties', () => {
    expect(parseAllowlist(' 123 , 456 ,, 789 ')).toEqual(['123', '456', '789']);
  });
  it('returns [] for undefined or blank', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('  ')).toEqual([]);
  });
});

describe('isChatAuthorized', () => {
  it('allows everyone when the allowlist is empty (open default)', () => {
    expect(isChatAuthorized('123', [])).toEqual({ allowed: true, reason: 'no-allowlist' });
  });
  it('allows everyone on explicit wildcard', () => {
    expect(isChatAuthorized('123', ['*'])).toEqual({ allowed: true, reason: 'wildcard' });
  });
  it('allows a listed chat', () => {
    expect(isChatAuthorized('123', ['123', '456'])).toEqual({ allowed: true, reason: 'listed' });
  });
  it('denies an unlisted chat (fail-closed at the edge)', () => {
    expect(isChatAuthorized('999', ['123', '456'])).toEqual({ allowed: false, reason: 'denied' });
  });
});

describe('allowlistStartupWarning', () => {
  it('warns when no allowlist is set', () => {
    const w = allowlistStartupWarning('telegram', 'TELEGRAM_ALLOWED_CHATS', []);
    expect(w).toContain('TELEGRAM_ALLOWED_CHATS');
    expect(w).toContain('drive the agent');
  });
  it('is silent when an allowlist (or wildcard) is set', () => {
    expect(allowlistStartupWarning('telegram', 'TELEGRAM_ALLOWED_CHATS', ['123'])).toBeNull();
    expect(allowlistStartupWarning('telegram', 'TELEGRAM_ALLOWED_CHATS', ['*'])).toBeNull();
  });
});
