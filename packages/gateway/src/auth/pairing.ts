/**
 * Cryptographic agent pairing — hermes six-point hardening (TD-G, ADR-44 D-4).
 *
 *   1. Codes stored as salted SHA-256, never plaintext        (Phase 6)
 *   2. Unambiguous 32-char alphabet (no 0/O/1/I)              (Phase 11)
 *   3. Generation rate limit: 1 code / agent / 10 min          (Phase 11)
 *   4. Failed-attempt lockout: 5 wrong codes                   (Phase 6)
 *   5. Constant-time comparison (timingSafeEqual)              (Phase 6)
 *   6. DB persistence: agent_pairing table, migration 014      (Phase 11)
 *
 * Persistence model: in-memory Map is the hot cache; when a Pool is configured
 * (configurePairingPersistence), all mutations write through to agent_pairing
 * and warmPairingCache() loads survivors at boot. DB failures are best-effort —
 * the in-memory path keeps working. Cross-replica consistency is explicitly
 * deferred to Phase 15 (ADR-44 D-4).
 */

import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import type { Pool } from 'pg';

export const TTL_SECONDS = 3600;
export const MAX_FAILED_ATTEMPTS = 5;
export const GENERATION_RATE_LIMIT_MS = 10 * 60 * 1000;

interface PairingEntry {
  hash: string;
  salt: string;
  agentId: string;
  createdAt: number;
  lastGeneratedAt: number;
  failedAttempts: number;
  paired: boolean;
}

const store = new Map<string, PairingEntry>();

let persistencePool: Pool | null = null;

/** Enable write-through persistence to the agent_pairing table (migration 014). */
export function configurePairingPersistence(pool: Pool | null): void {
  persistencePool = pool;
}

/** Load persisted pairing state into the hot cache at boot. */
export async function warmPairingCache(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{
    agent_id: string;
    code_hash: string;
    salt: string;
    created_at: Date;
    last_generated_at: Date;
    failed_attempts: number;
    paired: boolean;
  }>(`SELECT agent_id, code_hash, salt, created_at, last_generated_at, failed_attempts, paired
      FROM agent_pairing`);
  for (const row of rows) {
    store.set(row.agent_id, {
      hash: row.code_hash,
      salt: row.salt,
      agentId: row.agent_id,
      createdAt: row.created_at.getTime(),
      lastGeneratedAt: row.last_generated_at.getTime(),
      failedAttempts: row.failed_attempts,
      paired: row.paired,
    });
  }
  return rows.length;
}

function persist(entry: PairingEntry): void {
  if (!persistencePool) return;
  void persistencePool
    .query(
      `INSERT INTO agent_pairing (agent_id, code_hash, salt, created_at, last_generated_at, failed_attempts, paired)
       VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6, $7)
       ON CONFLICT (agent_id) DO UPDATE SET
         code_hash = EXCLUDED.code_hash,
         salt = EXCLUDED.salt,
         created_at = EXCLUDED.created_at,
         last_generated_at = EXCLUDED.last_generated_at,
         failed_attempts = EXCLUDED.failed_attempts,
         paired = EXCLUDED.paired`,
      [entry.agentId, entry.hash, entry.salt, entry.createdAt, entry.lastGeneratedAt, entry.failedAttempts, entry.paired],
    )
    .catch(() => {
      /* best-effort: in-memory path keeps working when DB is down */
    });
}

// Unambiguous alphabet: 32 chars, 0/O/1/I removed. 256 % 32 === 0, so
// `byte % 32` introduces no modulo bias.
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes).map((b) => CHARS[b % CHARS.length]).join('').slice(0, 8);
}

export function generatePairingCode(
  agentId: string,
): { code: string; expiresAt: number } | { error: 'rate_limited'; retryAfterMs: number } {
  const existing = store.get(agentId);
  if (existing && !existing.paired) {
    const elapsed = Date.now() - existing.lastGeneratedAt;
    if (elapsed < GENERATION_RATE_LIMIT_MS) {
      return { error: 'rate_limited', retryAfterMs: GENERATION_RATE_LIMIT_MS - elapsed };
    }
  }
  const code = generateCode();
  const salt = randomBytes(16).toString('hex');
  const hash = createHash('sha256').update(code + salt).digest('hex');
  const now = Date.now();
  const entry: PairingEntry = {
    hash,
    salt,
    agentId,
    createdAt: now,
    lastGeneratedAt: now,
    failedAttempts: 0,
    paired: false,
  };
  store.set(agentId, entry);
  persist(entry);
  return { code, expiresAt: now + TTL_SECONDS * 1000 };
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
    persist(entry);
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true };
}

export function markPaired(agentId: string): void {
  const entry = store.get(agentId);
  if (entry) {
    entry.paired = true;
    persist(entry);
  }
}

export function isPaired(agentId: string): boolean {
  return store.get(agentId)?.paired ?? false;
}

export function _resetStoreForTest(): void {
  store.clear();
  persistencePool = null;
}
