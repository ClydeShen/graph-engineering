/**
 * Credential vault (ADR-53 / Phase 20) — per-service secrets with
 * crypto-shredding erase semantics (ADR-43 mechanism at service granularity).
 *
 * Envelope encryption: each service gets a random DEK (AES-256-GCM over the
 * secret); the DEK is wrapped by the operator KEK from MEMEX_VAULT_KEK
 * (32 bytes, base64). Destroying the wrapped DEK row (`shred`) makes the
 * ciphertext permanently unreadable — including in backups taken after the
 * shred (ADR-48 backup semantics still apply to earlier backups).
 *
 * Boundary discipline (ADR-53):
 *   - secret VALUES never enter the ledger or LLM context
 *   - prompts carry `{{vault:<service>}}` placeholders (redact direction)
 *   - placeholders resolve to plaintext ONLY at the tool execution boundary
 *     (inject direction), immediately before subprocess/transport use
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';

const ALG = 'aes-256-gcm';

export class VaultKeyMissingError extends Error {
  constructor() {
    super('MEMEX_VAULT_KEK is not set (32 random bytes, base64) — the vault is unavailable');
  }
}

function kek(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env['MEMEX_VAULT_KEK'];
  if (!raw) throw new VaultKeyMissingError();
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('MEMEX_VAULT_KEK must decode to exactly 32 bytes');
  return buf;
}

interface Sealed {
  ciphertext: string;
  iv: string;
  tag: string;
}

function seal(key: Buffer, plaintext: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}

function open(key: Buffer, sealed: Sealed): Buffer {
  const decipher = createDecipheriv(ALG, key, Buffer.from(sealed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
}

/** Valid service names — placeholder syntax depends on this shape. */
export function safeServiceName(service: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(service);
}

/** Store (upsert) a secret for a service. The old DEK is replaced wholesale. */
export async function vaultStore(
  pool: Pool,
  service: string,
  secret: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!safeServiceName(service)) throw new Error(`invalid service name: ${service}`);
  const dek = randomBytes(32);
  const sealedSecret = seal(dek, Buffer.from(secret, 'utf8'));
  const sealedDek = seal(kek(env), dek);
  await pool.query(
    `INSERT INTO credential_vault (service, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_tag, destroyed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
     ON CONFLICT (service) DO UPDATE SET
       ciphertext = $2, iv = $3, auth_tag = $4,
       wrapped_dek = $5, wrap_iv = $6, wrap_tag = $7,
       created_at = NOW(), destroyed_at = NULL`,
    [service, sealedSecret.ciphertext, sealedSecret.iv, sealedSecret.tag,
     sealedDek.ciphertext, sealedDek.iv, sealedDek.tag],
  );
}

/** Retrieve a secret. Null when absent or shredded. */
export async function vaultRetrieve(
  pool: Pool,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const { rows } = await pool.query<{
    ciphertext: string; iv: string; auth_tag: string;
    wrapped_dek: string | null; wrap_iv: string | null; wrap_tag: string | null;
  }>(
    `SELECT ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_tag
     FROM credential_vault WHERE service = $1 AND destroyed_at IS NULL`,
    [service],
  );
  const row = rows[0];
  if (!row || row.wrapped_dek === null) return null;
  const dek = open(kek(env), { ciphertext: row.wrapped_dek, iv: row.wrap_iv!, tag: row.wrap_tag! });
  return open(dek, { ciphertext: row.ciphertext, iv: row.iv, tag: row.auth_tag }).toString('utf8');
}

/** Crypto-shred: destroy the wrapped DEK — ciphertext becomes permanently dead. */
export async function vaultShred(pool: Pool, service: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE credential_vault
     SET wrapped_dek = NULL, wrap_iv = NULL, wrap_tag = NULL, destroyed_at = NOW()
     WHERE service = $1 AND destroyed_at IS NULL`,
    [service],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Services currently holding a live secret (names only — never values). */
export async function vaultList(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ service: string }>(
    `SELECT service FROM credential_vault WHERE destroyed_at IS NULL ORDER BY service`,
  );
  return rows.map((r) => r.service);
}

const PLACEHOLDER_RE = /\{\{vault:([a-z0-9][a-z0-9._-]{0,63})\}\}/g;

/**
 * Redact direction: replace known secret VALUES with placeholders before any
 * text reaches the LLM or the ledger. Caller supplies the live values map
 * (service → value) it is responsible for.
 */
export function redactSecrets(text: string, values: Record<string, string>): string {
  let out = text;
  for (const [service, value] of Object.entries(values)) {
    if (value.length === 0) continue;
    out = out.split(value).join(`{{vault:${service}}}`);
  }
  return out;
}

/**
 * Inject direction: resolve placeholders to plaintext at the tool execution
 * boundary ONLY. Unknown/shredded services resolve to '' and are reported so
 * the caller can fail closed.
 */
export async function injectSecrets(
  pool: Pool,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ resolved: string; missing: string[] }> {
  const missing: string[] = [];
  const services = [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1]!))];
  const values = new Map<string, string>();
  for (const service of services) {
    const v = await vaultRetrieve(pool, service, env);
    if (v === null) missing.push(service);
    else values.set(service, v);
  }
  const resolved = text.replace(PLACEHOLDER_RE, (whole, service: string) => values.get(service) ?? whole);
  return { resolved, missing };
}
