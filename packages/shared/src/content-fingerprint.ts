import { createHash } from 'node:crypto';

// Compute a hex-encoded SHA-256 fingerprint of content.
// Used as content_hash in event payloads (audit trail) and as fingerprintId for lesson dedup.
export function contentFingerprint(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
