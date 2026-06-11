/**
 * memex doctor — pure diagnostics, never mutates config or data (Phase 15 G4,
 * hermes doctor.py pattern). Every check is independent: a failure is reported
 * and the remaining checks still run.
 *
 * All effects are behind DoctorProbes so each check is unit-testable without a
 * database, gateway, or network. buildRealProbes() wires the production set.
 *
 * Hash-chain check implements the ADR-43 D-3 rule that Phase 14 deferred here:
 * rows with erased_at set are EXCLUDED from content re-verification (their
 * payload was blanked, so the recomputed digest can no longer match) but stay
 * INCLUDED in linkage verification — the chain itself must remain intact.
 */

import { ZERO_HASH, loadMemexConfig, activeProfile, type MemexConfig } from '@graph/shared';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorResult {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorProbes {
  loadConfig(): MemexConfig | null;
  /** SQL probe; throw to signal "postgres unreachable". Null = no DB configured. */
  query: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null;
  fetchFn: typeof fetch;
  nodeVersion: string;
  env: NodeJS.ProcessEnv;
}

const HASH_CHAIN_SAMPLE_SCOPES = 3;

async function checkConfig(p: DoctorProbes): Promise<DoctorResult> {
  const profile = activeProfile() ?? 'default';
  const config = p.loadConfig();
  if (config === null) {
    return {
      name: 'config',
      status: 'warn',
      detail: `profile '${profile}': no valid config.json (env-vars-only boot still works)`,
    };
  }
  return { name: 'config', status: 'ok', detail: `profile '${profile}': config.json parsed` };
}

function checkNodeVersion(p: DoctorProbes): DoctorResult {
  const major = Number(p.nodeVersion.replace(/^v/, '').split('.')[0]);
  if (Number.isNaN(major)) {
    return { name: 'node-version', status: 'warn', detail: `unparseable version '${p.nodeVersion}'` };
  }
  return major >= 22
    ? { name: 'node-version', status: 'ok', detail: `${p.nodeVersion} (>= 22)` }
    : { name: 'node-version', status: 'fail', detail: `${p.nodeVersion} — Node 22+ required (TD-M single runtime)` };
}

async function checkPostgres(p: DoctorProbes): Promise<DoctorResult> {
  if (!p.query) return { name: 'postgres', status: 'fail', detail: 'no DATABASE_URL or config database.url' };
  try {
    const { rows } = await p.query(
      `SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pgcrypto')`,
    );
    const found = new Set(rows.map((r) => String(r['extname'])));
    const missing = ['vector', 'pgcrypto'].filter((e) => !found.has(e));
    if (missing.length > 0) {
      return { name: 'postgres', status: 'fail', detail: `reachable, but extensions missing: ${missing.join(', ')}` };
    }
    return { name: 'postgres', status: 'ok', detail: 'reachable; pgvector + pgcrypto present' };
  } catch (err) {
    return { name: 'postgres', status: 'fail', detail: `unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

async function checkMigrations(p: DoctorProbes): Promise<DoctorResult> {
  if (!p.query) return { name: 'migrations', status: 'skip', detail: 'no database connection' };
  try {
    // Watermark column: erased_at landed in 016 (latest schema-shape migration).
    const { rows } = await p.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'execution_event_log' AND column_name = 'erased_at'`,
    );
    return rows.length > 0
      ? { name: 'migrations', status: 'ok', detail: 'schema at migration 016+ watermark' }
      : { name: 'migrations', status: 'warn', detail: 'erased_at missing — run npm run db:migrate' };
  } catch (err) {
    return { name: 'migrations', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkHashChain(p: DoctorProbes): Promise<DoctorResult> {
  if (!p.query) return { name: 'hash-chain', status: 'skip', detail: 'no database connection' };
  try {
    const { rows: scopes } = await p.query(
      `SELECT scope_id FROM (SELECT DISTINCT scope_id FROM execution_event_log) s
       ORDER BY random() LIMIT $1`,
      [HASH_CHAIN_SAMPLE_SCOPES],
    );
    if (scopes.length === 0) {
      return { name: 'hash-chain', status: 'ok', detail: 'ledger empty — nothing to verify' };
    }
    for (const row of scopes) {
      const scopeId = String(row['scope_id']);
      // Content re-verification — erased rows excluded (ADR-43 D-3).
      const { rows: badContent } = await p.query(
        `SELECT count(*)::int AS bad FROM execution_event_log
         WHERE scope_id = $1
           AND erased_at IS NULL
           AND version_hash <> encode(digest(
             scope_id::text || '|' || entity_id::text || '|' || predecessor_hash
               || '|' || event_type || '|' || payload, 'sha256'), 'hex')`,
        [scopeId],
      );
      if (Number(badContent[0]?.['bad']) > 0) {
        return { name: 'hash-chain', status: 'fail', detail: `scope ${scopeId}: ${String(badContent[0]?.['bad'])} hash mismatch(es)` };
      }
      // Linkage verification — erased rows INCLUDED (chain must stay intact).
      const { rows: broken } = await p.query(
        `SELECT count(*)::int AS broken FROM execution_event_log e
         WHERE e.scope_id = $1 AND e.predecessor_hash <> $2
           AND NOT EXISTS (
             SELECT 1 FROM execution_event_log pr
             WHERE pr.scope_id = $1 AND pr.version_hash = e.predecessor_hash)`,
        [scopeId, ZERO_HASH],
      );
      if (Number(broken[0]?.['broken']) > 0) {
        return { name: 'hash-chain', status: 'fail', detail: `scope ${scopeId}: ${String(broken[0]?.['broken'])} dangling predecessor link(s)` };
      }
    }
    return { name: 'hash-chain', status: 'ok', detail: `${scopes.length} scope(s) sampled — content + linkage intact` };
  } catch (err) {
    return { name: 'hash-chain', status: 'fail', detail: err instanceof Error ? err.message : String(err) };
  }
}

async function checkProviders(p: DoctorProbes): Promise<DoctorResult> {
  const providers = p.loadConfig()?.providers ?? [];
  if (providers.length === 0) {
    return { name: 'llm-providers', status: 'warn', detail: 'no providers in config (workers fall back to iii-config.yaml)' };
  }
  const parts: string[] = [];
  let failed = 0;
  for (const prov of providers) {
    if (prov.baseUrl) {
      try {
        // Any HTTP response (even 401/404) proves the endpoint is reachable.
        await p.fetchFn(prov.baseUrl, { method: 'GET', signal: AbortSignal.timeout(5000) });
        parts.push(`${prov.name}: reachable`);
      } catch {
        parts.push(`${prov.name}: UNREACHABLE`);
        failed++;
      }
    } else {
      parts.push(`${prov.name}: ${prov.apiKey ? 'key configured (not probed)' : 'NO KEY'}`);
      if (!prov.apiKey) failed++;
    }
  }
  return {
    name: 'llm-providers',
    status: failed === 0 ? 'ok' : 'warn',
    detail: parts.join('; '),
  };
}

async function checkGateway(p: DoctorProbes): Promise<DoctorResult> {
  const config = p.loadConfig();
  const url =
    config?.shell?.gateway_url ?? `http://127.0.0.1:${config?.gateway?.port ?? p.env['PORT'] ?? 3000}`;
  try {
    const res = await p.fetchFn(`${url}/v1/sys/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { name: 'gateway', status: 'warn', detail: `${url} responded ${res.status}` };
    return { name: 'gateway', status: 'ok', detail: `${url} alive` };
  } catch {
    return { name: 'gateway', status: 'warn', detail: `${url} not running` };
  }
}

function checkChannels(p: DoctorProbes): DoctorResult {
  const channels = p.loadConfig()?.channels ?? {};
  const names = Object.keys(channels);
  if (names.length === 0) return { name: 'channels', status: 'ok', detail: 'no channels configured' };
  // Presence only — doctor never makes outbound channel calls (token 真伪不验).
  const missing = names.filter((n) => !channels[n]?.token);
  return missing.length === 0
    ? { name: 'channels', status: 'ok', detail: `${names.length} channel(s), tokens present` }
    : { name: 'channels', status: 'warn', detail: `token missing for: ${missing.join(', ')}` };
}

/** Run all checks. Failures never abort the run — doctor reports, it does not fix. */
export async function runDoctor(p: DoctorProbes): Promise<DoctorResult[]> {
  return [
    await checkConfig(p),
    checkNodeVersion(p),
    await checkPostgres(p),
    await checkMigrations(p),
    await checkHashChain(p),
    await checkProviders(p),
    await checkGateway(p),
    checkChannels(p),
  ];
}

/** Production probe set. pg is imported lazily so `memex doctor --help` stays instant. */
export async function buildRealProbes(): Promise<DoctorProbes> {
  const config = loadMemexConfig();
  const dbUrl = process.env['DATABASE_URL'] ?? config?.database?.url;
  let query: DoctorProbes['query'] = null;
  if (dbUrl) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: dbUrl, max: 1, connectionTimeoutMillis: 5000 });
    query = (sql, params) => pool.query(sql, params as never);
  }
  return {
    loadConfig: () => loadMemexConfig(),
    query,
    fetchFn: fetch,
    nodeVersion: process.version,
    env: process.env,
  };
}

export function formatDoctorReport(results: DoctorResult[]): string {
  const icon: Record<DoctorStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };
  const lines = results.map((r) => `  ${icon[r.status]} ${r.name.padEnd(14)} ${r.detail}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push('', `  ${fails} failure(s), ${warns} warning(s)`);
  return lines.join('\n');
}
