import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  injectSecrets,
  redactSecrets,
  safeServiceName,
  vaultRetrieve,
  vaultShred,
  vaultStore,
  VaultKeyMissingError,
} from './vault.js';

const ENV = { MEMEX_VAULT_KEK: randomBytes(32).toString('base64') };

/** In-memory pool honoring the vault's SQL shapes. */
function makeVaultPool(): Pool {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('INSERT INTO credential_vault')) {
        const [service, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_tag] = params as string[];
        rows.set(service!, { ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_tag, destroyed_at: null });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT ciphertext')) {
        const row = rows.get(params[0] as string);
        return { rows: row && row['destroyed_at'] === null ? [row] : [], rowCount: 0 };
      }
      if (sql.includes('SET wrapped_dek = NULL')) {
        const row = rows.get(params[0] as string);
        if (!row || row['destroyed_at'] !== null) return { rows: [], rowCount: 0 };
        row['wrapped_dek'] = null;
        row['destroyed_at'] = 'now';
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT service')) {
        return { rows: [...rows.entries()].filter(([, r]) => r['destroyed_at'] === null).map(([service]) => ({ service })), rowCount: 0 };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
  } as unknown as Pool;
}

describe('credential vault', () => {
  it('round-trips a secret through envelope encryption', async () => {
    const pool = makeVaultPool();
    await vaultStore(pool, 'tennis-club', 's3cret-pw', ENV);
    expect(await vaultRetrieve(pool, 'tennis-club', ENV)).toBe('s3cret-pw');
  });

  it('shred destroys the DEK — retrieve returns null forever after', async () => {
    const pool = makeVaultPool();
    await vaultStore(pool, 'svc', 'value', ENV);
    expect(await vaultShred(pool, 'svc')).toBe(true);
    expect(await vaultRetrieve(pool, 'svc', ENV)).toBeNull();
    expect(await vaultShred(pool, 'svc')).toBe(false); // idempotent-ish: already dead
  });

  it('fails closed without the KEK and rejects bad service names', async () => {
    const pool = makeVaultPool();
    await expect(vaultStore(pool, 'svc', 'v', {})).rejects.toThrow(VaultKeyMissingError);
    await expect(vaultStore(pool, '../evil', 'v', ENV)).rejects.toThrow(/invalid service/);
    expect(safeServiceName('ok-svc.1')).toBe(true);
    expect(safeServiceName('No Caps')).toBe(false);
  });
});

describe('redact / inject directions', () => {
  it('redactSecrets replaces VALUES with placeholders (LLM direction)', () => {
    const out = redactSecrets('login with s3cret-pw now', { 'tennis-club': 's3cret-pw' });
    expect(out).toBe('login with {{vault:tennis-club}} now');
    expect(out).not.toContain('s3cret');
  });

  it('injectSecrets resolves placeholders at the boundary; missing fails closed', async () => {
    const pool = makeVaultPool();
    await vaultStore(pool, 'tennis-club', 's3cret-pw', ENV);
    const ok = await injectSecrets(pool, 'pw={{vault:tennis-club}}', ENV);
    expect(ok).toEqual({ resolved: 'pw=s3cret-pw', missing: [] });

    const gone = await injectSecrets(pool, 'pw={{vault:unknown-svc}}', ENV);
    expect(gone.missing).toEqual(['unknown-svc']);
    expect(gone.resolved).toContain('{{vault:unknown-svc}}'); // untouched, caller fails closed
  });
});
