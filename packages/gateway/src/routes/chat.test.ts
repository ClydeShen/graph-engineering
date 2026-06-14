import { describe, it, expect } from 'vitest';
import { platformFromPrincipal } from './chat.js';

describe('platformFromPrincipal (per-channel routing key)', () => {
  it('extracts the platform from a session-key principal', () => {
    expect(platformFromPrincipal('telegram::123')).toBe('telegram');
    expect(platformFromPrincipal('slack::C0XYZ')).toBe('slack');
  });

  it('returns null when there is no platform prefix', () => {
    expect(platformFromPrincipal(undefined)).toBeNull();
    expect(platformFromPrincipal('some-uuid-console-principal')).toBeNull();
    expect(platformFromPrincipal('::leading')).toBeNull(); // no platform before '::'
  });
});
