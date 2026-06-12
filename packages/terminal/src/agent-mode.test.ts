import { describe, expect, it } from 'vitest';
import { truncateForLedger } from './agent-mode.js';

describe('truncateForLedger', () => {
  it('passes short strings through', () => {
    expect(truncateForLedger('ok')).toBe('ok');
  });

  it('truncates long content with a length marker (token discipline)', () => {
    const long = 'x'.repeat(600);
    const out = truncateForLedger(long);
    expect(out.length).toBeLessThan(560);
    expect(out).toContain('[+100 chars]');
  });

  it('serializes non-strings', () => {
    expect(truncateForLedger({ a: 1 })).toBe('{"a":1}');
  });
});
