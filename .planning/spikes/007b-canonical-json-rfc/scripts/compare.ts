/**
 * Spike 007b — Byte-parity comparison: canonicalJson() vs canonical-json (RFC 8785)
 *
 * Run: npx tsx .planning/spikes/007b-canonical-json-rfc/scripts/compare.ts
 *
 * Exit 0 = byte-for-byte identical on all test cases → safe to replace
 * Exit 1 = any divergence → replacement would change version hashes → BLOCKED
 *
 * NOTE: RFC 8785 (JCS — JSON Canonicalization Scheme) differs from simple key-sort:
 * - Numbers are serialized using IEEE 754 double precision rules
 * - Unicode code points are NOT escaped unless required
 * This spike checks if RFC 8785 output matches our current JSON.stringify-based output.
 */

import { createHash } from 'crypto';

// ─── Current implementation (verbatim from packages/shared/src/canonical-json.ts) ───

function sortedValue(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map(sortedValue);
  if (payload !== null && typeof payload === 'object') {
    return Object.fromEntries(
      Object.keys(payload as object)
        .sort()
        .map((k) => [k, sortedValue((payload as Record<string, unknown>)[k])])
    );
  }
  return payload;
}

function canonicalJson(payload: unknown): string {
  return JSON.stringify(sortedValue(payload));
}

// ─── Test cases (same set as 007a for direct comparison) ──────────────────────

const cases: Array<{ label: string; input: unknown }> = [
  { label: 'flat object — key order', input: { z: 1, a: 2, m: 3 } },
  { label: 'flat object — already sorted', input: { a: 1, b: 2, c: 3 } },
  { label: 'nested object', input: { outer: { z: 99, a: 1 }, b: 'hello' } },
  { label: 'deeply nested', input: { x: { y: { z: { c: 3, a: 1, b: 2 } } } } },
  { label: 'array of primitives', input: [3, 1, 2] },
  { label: 'array of objects', input: [{ z: 1, a: 2 }, { y: 3, b: 4 }] },
  { label: 'array preserves order', input: ['z', 'a', 'b'] },
  { label: 'string', input: 'hello world' },
  { label: 'number', input: 42 },
  { label: 'boolean true', input: true },
  { label: 'boolean false', input: false },
  { label: 'null', input: null },
  { label: 'empty object', input: {} },
  { label: 'empty array', input: [] },
  { label: 'unicode string', input: { name: '你好世界', val: 'café' } },
  { label: 'special chars', input: { key: 'value with "quotes" and \\backslash' } },
  { label: 'integer 0', input: 0 },
  { label: 'negative number', input: -1.5 },
  // RFC 8785 specifically defines -0 handling (must serialize as '0')
  { label: '-0 value', input: { x: -0 } },
  { label: 'mixed types', input: { arr: [1, null, true, { z: 'a', a: 'z' }], num: 3.14, str: 'test' } },
  {
    label: 'version hash payload',
    input: {
      scope_id: '550e8400-e29b-41d4-a716-446655440000',
      entity_id: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
      event_type: 'memory_updated',
      predecessor_hash: 'abc123def456',
      payload: { content: 'test', z_field: true, a_field: 42 },
    },
  },
  // RFC 8785 extra: floating point edge cases
  { label: 'float 1e308', input: { v: 1e308 } },
  { label: 'float 5e-324', input: { v: 5e-324 } },
];

// ─── Run comparison (async IIFE — canonical-json is pure ESM, must dynamic-import) ──

(async () => {
  const { default: canonicalJsonRfc } = await import('canonical-json') as { default: (payload: unknown) => string };

  let passed = 0;
  let failed = 0;

  console.log('Spike 007b — canonical-json (RFC 8785) byte parity\n');
  console.log(`${'Case'.padEnd(45)} ${'custom'.padEnd(12)} ${'rfc8785'.padEnd(12)} ${'match?'}`);
  console.log('─'.repeat(80));

  for (const { label, input } of cases) {
    const custom = canonicalJson(input);
    let rfc: string;
    try {
      rfc = canonicalJsonRfc(input);
    } catch (e) {
      rfc = `ERROR: ${(e as Error).message}`;
    }

    const customHash = createHash('sha256').update(custom).digest('hex').slice(0, 8);
    const rfcHash = createHash('sha256').update(rfc!).digest('hex').slice(0, 8);
    const match = custom === rfc;

    const status = match ? '✓ MATCH' : '✗ DIFFER';
    console.log(`${label.padEnd(45)} ${customHash.padEnd(12)} ${rfcHash.padEnd(12)} ${status}`);

    if (!match) {
      console.log(`  custom:  ${custom}`);
      console.log(`  rfc8785: ${rfc}`);
      failed++;
    } else {
      passed++;
    }
  }

  console.log('─'.repeat(80));
  console.log(`\nResults: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log('\n✓ VERDICT: byte-for-byte identical — safe to replace canonicalJson() with canonical-json (RFC 8785)');
    process.exit(0);
  } else {
    console.log('\n✗ VERDICT: divergence detected — RFC 8785 uses different number/unicode encoding — DO NOT replace without hash migration');
    process.exit(1);
  }
})();
