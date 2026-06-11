import { describe, it, expect } from 'vitest';
import { generateChecksums, verifyChecksums, RELEASE_ARTIFACTS, sha256Hex } from './release.js';

const files: Record<string, Buffer> = {
  'scripts/install.sh': Buffer.from('#!/bin/sh\necho install\n'),
  'deploy/Dockerfile': Buffer.from('FROM node:22-slim\n'),
};
const readFile = (p: string): Buffer => {
  const f = files[p];
  if (!f) throw new Error('ENOENT');
  return f;
};

describe('release checksums (Phase 16 G5)', () => {
  const artifacts = Object.keys(files);

  it('generates sha256sum-compatible lines for every artifact', () => {
    const sums = generateChecksums(readFile, artifacts);
    const lines = sums.trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatch(/^[0-9a-f]{64}  \S/);
    }
    expect(sums).toContain(sha256Hex(files['scripts/install.sh']!));
  });

  it('verification passes on untouched files', () => {
    const sums = generateChecksums(readFile, artifacts);
    expect(verifyChecksums(sums, readFile)).toEqual([]);
  });

  it('a single corrupted byte fails verification (G5 gate)', () => {
    const sums = generateChecksums(readFile, artifacts);
    const corrupted = Buffer.from(files['scripts/install.sh']!);
    corrupted[0] = corrupted[0]! ^ 0x01; // flip one bit
    const tamperedRead = (p: string): Buffer =>
      p === 'scripts/install.sh' ? corrupted : readFile(p);
    const failures = verifyChecksums(sums, tamperedRead);
    expect(failures).toEqual([{ path: 'scripts/install.sh', reason: 'mismatch' }]);
  });

  it('missing files and malformed lines are reported, not thrown', () => {
    const sums = generateChecksums(readFile, artifacts) + 'not a checksum line\n';
    const missingRead = (p: string): Buffer => {
      if (p === 'deploy/Dockerfile') throw new Error('ENOENT');
      return readFile(p);
    };
    const failures = verifyChecksums(sums, missingRead);
    expect(failures).toContainEqual({ path: 'deploy/Dockerfile', reason: 'unreadable' });
    expect(failures.some((f) => f.reason === 'malformed-line')).toBe(true);
  });

  it('frozen artifact list matches ADR-48 forward contract', () => {
    expect(RELEASE_ARTIFACTS).toEqual([
      'scripts/install.sh',
      'scripts/install.ps1',
      'deploy/Dockerfile',
      'deploy/docker-compose.yml',
      'deploy/docker-compose.hardened.yml',
    ]);
  });
});
