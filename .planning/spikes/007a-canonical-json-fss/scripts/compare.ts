/**
 * Spike 007a — Byte-parity comparison: canonicalJson() vs fast-json-stable-stringify
 *
 * Run: npx tsx .planning/spikes/007a-canonical-json-fss/scripts/compare.ts
 *
 * Exit 0 = byte-for-byte identical on all test cases → safe to replace
 * Exit 1 = any divergence → replacement would change version hashes → BLOCKED
 */

import stringify from 'fast-json-stable-stringify';
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

// ─── Test cases ───────────────────────────────────────────────────────────────

const cases: Array<{ label: string; input: unknown }> = [
  // Basic key sorting
  { label: 'flat object — key order', input: { z: 1, a: 2, m: 3 } },
  { label: 'flat object — already sorted', input: { a: 1, b: 2, c: 3 } },

  // Nested objects
  { label: 'nested object', input: { outer: { z: 99, a: 1 }, b: 'hello' } },
  { label: 'deeply nested', input: { x: { y: { z: { c: 3, a: 1, b: 2 } } } } },

  // Arrays
  { label: 'array of primitives', input: [3, 1, 2] },
  { label: 'array of objects', input: [{ z: 1, a: 2 }, { y: 3, b: 4 }] },
  { label: 'array preserves order', input: ['z', 'a', 'b'] },

  // Primitives
  { label: 'string', input: 'hello world' },
  { label: 'number', input: 42 },
  { label: 'boolean true', input: true },
  { label: 'boolean false', input: false },
  { label: 'null', input: null },

  // Edge cases
  { label: 'empty object', input: {} },
  { label: 'empty array', input: [] },
  { label: 'unicode string', input: { name: '你好世界', val: 'café' } },
  { label: 'special chars', input: { key: 'value with "quotes" and \\backslash' } },
  { label: 'integer 0', input: 0 },
  { label: 'negative number', input: -1.5 },

  // Critical: -0 handling (JSON.stringify converts -0 to '0')
  { label: '-0 value', input: { x: -0 } },

  // Mixed nesting
  { label: 'mixed types', input: { arr: [1, null, true, { z: 'a', a: 'z' }], num: 3.14, str: 'test' } },

  // Real-world: version hash payload shape
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

  // Prototype-less objects
  { label: 'Object.create(null)', input: Object.assign(Object.create(null), { z: 1, a: 2 }) },
];

// ─── Run comparison ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

console.log('Spike 007a — fast-json-stable-stringify byte parity\n');
console.log(`${'Case'.padEnd(45)} ${'custom'.padEnd(12)} ${'fss'.padEnd(12)} ${'match?'}`);
console.log('─'.repeat(80));

for (const { label, input } of cases) {
  const custom = canonicalJson(input);
  const fss = stringify(input);

  const customHash = createHash('sha256').update(custom).digest('hex').slice(0, 8);
  const fssHash = createHash('sha256').update(fss ?? '').digest('hex').slice(0, 8);
  const match = custom === fss;

  const status = match ? '✓ MATCH' : '✗ DIFFER';
  console.log(`${label.padEnd(45)} ${customHash.padEnd(12)} ${fssHash.padEnd(12)} ${status}`);

  if (!match) {
    console.log(`  custom: ${custom}`);
    console.log(`  fss:    ${fss}`);
    failed++;
  } else {
    passed++;
  }
}

console.log('─'.repeat(80));
console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('\n✓ VERDICT: byte-for-byte identical — safe to replace canonicalJson() with fss');
  process.exit(0);
} else {
  console.log('\n✗ VERDICT: divergence detected — replacement would change version hashes — DO NOT replace');
  process.exit(1);
}
