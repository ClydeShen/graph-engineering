import { randomBytes, createHash, timingSafeEqual } from 'crypto';

export const TTL_SECONDS = 3600;
export const MAX_FAILED_ATTEMPTS = 5;

interface PairingEntry {
  hash: string;
  salt: string;
  agentId: string;
  createdAt: number;
  failedAttempts: number;
  paired: boolean;
}

// In-memory store — intentionally single-process (Phase 6 scope constraint).
// Multi-process deployments require a PostgreSQL-backed agent_pairing table (future phase).
const store = new Map<string, PairingEntry>();

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes).map((b) => CHARS[b % CHARS.length]).join('').slice(0, 8);
}

export function generatePairingCode(agentId: string): { code: string; expiresAt: number } {
  const code = generateCode();
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(code + salt).digest('hex');
  store.set(agentId, { hash, salt, agentId, createdAt: Date.now(), failedAttempts: 0, paired: false });
  return { code, expiresAt: Date.now() + TTL_SECONDS * 1000 };
}

export function verifyPairingCode(
  agentId: string,
  code: string,
): { ok: true } | { ok: false; reason: 'expired' | 'locked' | 'invalid' } {
  const entry = store.get(agentId);
  if (!entry) return { ok: false, reason: 'invalid' };

  if (Date.now() - entry.createdAt > TTL_SECONDS * 1000) {
    return { ok: false, reason: 'expired' };
  }
  if (entry.failedAttempts >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: 'locked' };
  }

  const inputHash = createHash('sha256').update(code + entry.salt).digest('hex');
  const matches = timingSafeEqual(Buffer.from(inputHash), Buffer.from(entry.hash));
  if (!matches) {
    entry.failedAttempts++;
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true };
}

export function markPaired(agentId: string): void {
  const entry = store.get(agentId);
  if (entry) entry.paired = true;
}

export function isPaired(agentId: string): boolean {
  return store.get(agentId)?.paired ?? false;
}

export function _resetStoreForTest(): void {
  store.clear();
}
