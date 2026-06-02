import { describe, it, expect } from 'vitest';
import { canonicalJson, hashablePayload } from '@shared/canonical-json';

describe('canonicalJson', () => {
  it('produces identical output for the same payload regardless of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('produces the correct sorted-key JSON string', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('does NOT double-encode array elements (array of objects)', () => {
    // This is the critical array encoding correctness test (REQ-03 / Pitfall 1)
    expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('does NOT double-encode plain string arrays', () => {
    expect(canonicalJson(['a', 'b'])).toBe('["a","b"]');
  });

  it('recursively sorts keys at every depth', () => {
    const input = { z: { d: 1, c: 2 }, a: { b: 3, a: 4 } };
    expect(canonicalJson(input)).toBe('{"a":{"a":4,"b":3},"z":{"c":2,"d":1}}');
  });
});

describe('hashablePayload', () => {
  it('strips _meta key before serializing', () => {
    const payload = { b: 1, a: 2, _meta: { ts: 'ignore' } };
    expect(hashablePayload(payload)).toBe('{"a":2,"b":1}');
  });

  it('strips schema_version key before serializing', () => {
    const payload = { b: 1, a: 2, schema_version: '1.0' };
    expect(hashablePayload(payload)).toBe('{"a":2,"b":1}');
  });

  it('strips both _meta and schema_version when both present', () => {
    const payload = { b: 1, a: 2, _meta: {}, schema_version: '1' };
    expect(hashablePayload(payload)).toBe('{"a":2,"b":1}');
  });
});
