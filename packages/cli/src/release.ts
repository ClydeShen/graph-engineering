/**
 * Release integrity (Phase 16 G5) — SHA-256SUMS over the published artifacts.
 *
 * Artifact list is FROZEN by ADR-48 (paths stop moving after Phase 15):
 * install scripts + docker deployment files. Signing (minisign/cosign) is a
 * documented manual release step — no private keys in the repo.
 */

import { createHash } from 'node:crypto';

/** Release artifacts, relative to the repo root (ADR-48 forward contract). */
export const RELEASE_ARTIFACTS = [
  'scripts/install.sh',
  'scripts/install.ps1',
  'deploy/Dockerfile',
  'deploy/docker-compose.yml',
  'deploy/docker-compose.hardened.yml',
] as const;

export type ReadFileFn = (path: string) => Buffer;

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Generate SHA-256SUMS content (sha256sum -c compatible: `<hash>  <path>`). */
export function generateChecksums(
  readFile: ReadFileFn,
  artifacts: readonly string[] = RELEASE_ARTIFACTS,
): string {
  return (
    artifacts.map((path) => `${sha256Hex(readFile(path))}  ${path}`).join('\n') + '\n'
  );
}

export interface ChecksumFailure {
  path: string;
  reason: 'mismatch' | 'unreadable' | 'malformed-line';
}

/** Verify a SHA-256SUMS document against current file contents. */
export function verifyChecksums(sums: string, readFile: ReadFileFn): ChecksumFailure[] {
  const failures: ChecksumFailure[] = [];
  for (const line of sums.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line);
    if (!m) {
      failures.push({ path: line.slice(0, 80), reason: 'malformed-line' });
      continue;
    }
    const [, expected, path] = m;
    try {
      if (sha256Hex(readFile(path!)) !== expected) {
        failures.push({ path: path!, reason: 'mismatch' });
      }
    } catch {
      failures.push({ path: path!, reason: 'unreadable' });
    }
  }
  return failures;
}
