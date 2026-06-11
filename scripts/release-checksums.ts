/**
 * Release step: generate (default) or verify (--verify) SHA-256SUMS for the
 * frozen artifact list (ADR-48). Run from the repo root.
 *
 *   npx tsx scripts/release-checksums.ts            # writes SHA-256SUMS
 *   npx tsx scripts/release-checksums.ts --verify   # exits 1 on any mismatch
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { generateChecksums, verifyChecksums } from '../packages/cli/src/release.js';

const readFile = (p: string): Buffer => readFileSync(p);

if (process.argv.includes('--verify')) {
  const failures = verifyChecksums(readFileSync('SHA-256SUMS', 'utf8'), readFile);
  if (failures.length > 0) {
    for (const f of failures) console.error(`✗ ${f.path}: ${f.reason}`);
    process.exit(1);
  }
  console.log('✓ all release artifacts verified');
} else {
  const sums = generateChecksums(readFile);
  writeFileSync('SHA-256SUMS', sums, 'utf8');
  console.log('SHA-256SUMS written:\n' + sums);
}
