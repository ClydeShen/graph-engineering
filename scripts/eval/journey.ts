/**
 * E2E acceptance journey (Phase 16 G3) — the UAT journey fixed as a repeatable
 * script. Live-gated: needs a migrated Postgres (DATABASE_URL) and a running
 * gateway (GATEWAY_URL, default http://127.0.0.1:4000).
 *
 *   DATABASE_URL=... GATEWAY_URL=... npx tsx scripts/eval/journey.ts
 *
 * Steps (each asserted, first failure exits 1):
 *   1. create scope            — 3-phase DDL nesting, plan_hash returned
 *   2. agent write             — OCC won, hash chain extended
 *   3. OCC conflict            — same predecessor → demoted (causal inversion)
 *   4. context projection      — knapsack compression metric sampled
 *   5. memory search           — hybrid retrieval route answers
 *   5a-5d. tennis-court north star (Phase 20, ADR-53; external endpoints mocked):
 *          acquisition approval gate / ask_user round-trip / vault lifecycle
 *          (KEK-gated) / capability endorsement surfacing
 *   6. erase(scope)            — payload blanked, chain intact (doctor rule)
 *   7. metrics snapshot        — written to .harness/analysis/eval-snapshot.json
 *      and compared against the previous snapshot (regression gate, ADR-49)
 *
 * Release gate order (ADR-49): doctor → full tests → this journey → snapshot compare.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {
  takeSnapshot,
  knapsackCompression,
  compareSnapshots,
  type EvalSnapshot,
} from '../../packages/cli/src/eval-metrics.js';
import { eraseScope } from '../../packages/gateway/src/security/erase.js';
import { ApprovalService } from '../../packages/gateway/src/security/approval.js';
import { AskUserService } from '../../packages/gateway/src/security/ask-user.js';
import { requestInstall, executeInstall } from '../../packages/gateway/src/security/acquisition.js';
import {
  buildCapabilityEndorsement,
  injectSecrets,
  recordActivation,
  redactSecrets,
  vaultShred,
  vaultStore,
} from '@graph/shared';

const GATEWAY = process.env['GATEWAY_URL'] ?? 'http://127.0.0.1:4000';
const DB = process.env['DATABASE_URL'];
const SNAPSHOT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../.harness/analysis/eval-snapshot.json',
);

let step = 0;
function pass(name: string, detail = ''): void {
  step++;
  console.log(`  ✓ step ${step}: ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name: string, detail: string): never {
  console.error(`  ✗ step ${step + 1}: ${name} — ${detail}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!DB) fail('preflight', 'DATABASE_URL not set');
  const pool = new Pool({ connectionString: DB, max: 2 });

  // 1. create scope
  const scopeRes = await fetch(`${GATEWAY}/v1/scopes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: 'eval-journey' }),
  });
  if (!scopeRes.ok) fail('create scope', `HTTP ${scopeRes.status}`);
  const { scope_id, plan_hash } = (await scopeRes.json()) as { scope_id: string; plan_hash: string };
  if (!scope_id || !plan_hash) fail('create scope', 'missing scope_id/plan_hash');
  pass('create scope', scope_id);

  // 2. agent write (OCC won)
  const entity = '22222222-2222-4222-8222-222222222222';
  const writeBody = (payload: Record<string, unknown>) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entity_id: entity,
      event_type: 'memory_updated',
      payload,
      predecessor_hash: plan_hash,
    }),
  });
  const w1 = await fetch(`${GATEWAY}/v1/scopes/${scope_id}/events`, writeBody({ note: 'journey write' }));
  if (!w1.ok) fail('agent write', `HTTP ${w1.status}`);
  const w1Body = (await w1.json()) as { occ_result: string; version_hash: string };
  if (w1Body.occ_result !== 'won') fail('agent write', `occ_result=${w1Body.occ_result}`);
  pass('agent write OCC won', w1Body.version_hash.slice(0, 12));

  // 3. OCC conflict — same predecessor slot must demote (ADR-41)
  const w2 = await fetch(`${GATEWAY}/v1/scopes/${scope_id}/events`, writeBody({ note: 'conflicting write' }));
  if (!w2.ok) fail('occ conflict', `HTTP ${w2.status}`);
  const w2Body = (await w2.json()) as { occ_result: string };
  if (w2Body.occ_result !== 'demoted') fail('occ conflict', `expected demoted, got ${w2Body.occ_result}`);
  pass('OCC conflict demoted (causal inversion)');

  // 4. context projection + compression metric
  const read = await fetch(`${GATEWAY}/v1/scopes/${scope_id}`);
  if (!read.ok) fail('context projection', `HTTP ${read.status}`);
  const readBody = (await read.json()) as {
    context: { context: unknown[]; droppedCount: number; ccrHashes: unknown[] };
  };
  const compression = knapsackCompression(readBody.context);
  pass('context projection', `kept=${compression.contextEvents} dropped=${compression.droppedCount}`);

  // 5. memory search route answers (hybrid retrieval)
  const search = await fetch(`${GATEWAY}/v1/memory/search?q=journey&scope_id=${scope_id}`);
  if (!search.ok) fail('memory search', `HTTP ${search.status}`);
  pass('memory search route answers');

  // ── Tennis-court north star (Phase 20, ADR-53; external endpoints mocked) ──

  // 5a. autonomous capability acquisition: agent cannot grant itself authority
  {
    const approvals = new ApprovalService(pool);
    const deps = {
      scanCandidate: async () => ({ findings: 1, report: 'MEDIUM network call in SKILL.md' }),
      performInstall: async () => ({ location: '/tmp/journey-skill' }),
    };
    const filed = await requestInstall(approvals, deps, scope_id, 'journey-agent', 'skill:agentskills.io:weather');
    const before = await executeInstall(pool, approvals, deps, filed.approval_id, 'skill:agentskills.io:weather', 'journey-agent');
    if (before.status !== 'pending') fail('acquisition gate', `install ran before approval: ${before.status}`);
    await approvals.decide(filed.approval_id, true, 'once');
    const after = await executeInstall(pool, approvals, deps, filed.approval_id, 'skill:agentskills.io:weather', 'journey-agent');
    if (after.status !== 'installed') fail('acquisition gate', `expected installed, got ${after.status}`);
    pass('acquisition gate: pending blocks, approval unblocks', `findings=${filed.findings}`);
  }

  // 5b. ask_user round-trip (question → human answer → agent reads it)
  {
    const askUser = new AskUserService(pool);
    const qid = await askUser.ask(scope_id, 'journey-agent', 'Book 6pm or 7pm?');
    if (!(await askUser.answer(qid, '7pm'))) fail('ask_user', 'answer transition failed');
    const status = await askUser.status(qid);
    if (status?.status !== 'answered' || status.answer !== '7pm') fail('ask_user', JSON.stringify(status));
    pass('ask_user round-trip', '7pm');
  }

  // 5c. vault boundary: store → redact (LLM direction) → inject (tool boundary) → shred
  if (process.env['MEMEX_VAULT_KEK']) {
    await vaultStore(pool, 'journey-court', 'pw-12345');
    const redacted = redactSecrets('login pw-12345', { 'journey-court': 'pw-12345' });
    if (redacted.includes('pw-12345')) fail('vault', 'redaction leaked the value');
    const injected = await injectSecrets(pool, redacted);
    if (!injected.resolved.includes('pw-12345')) fail('vault', 'injection failed');
    await vaultShred(pool, 'journey-court');
    if ((await injectSecrets(pool, redacted)).missing.length === 0) fail('vault', 'shred did not kill the secret');
    pass('vault: redact→inject→shred lifecycle');
  } else {
    pass('vault lifecycle', 'skipped (MEMEX_VAULT_KEK not set)');
  }

  // 5d. endorsement: capability co-occurrence becomes ranked cold-start evidence
  {
    await recordActivation(pool, scope_id, 'journey-weather-skill');
    const endorsement = await buildCapabilityEndorsement(pool);
    if (endorsement === null || !endorsement.includes('journey-weather-skill')) {
      fail('endorsement', 'activation did not surface in the endorsement block');
    }
    pass('endorsement: activation surfaces in cold-start evidence');
  }

  // 6. erase(scope) — ledger blanked, chain intact
  await eraseScope(pool, scope_id, 'eval-journey', 'admin');
  const { rows: blanked } = await pool.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM execution_event_log
     WHERE scope_id = $1 AND erased_at IS NOT NULL AND payload = ''`,
    [scope_id],
  );
  if (Number(blanked[0]?.n) === 0) fail('erase', 'no blanked rows');
  const { rows: links } = await pool.query<{ broken: string }>(
    `SELECT count(*)::int AS broken FROM execution_event_log e
     WHERE e.scope_id = $1 AND e.predecessor_hash <> repeat('0', 64)
       AND NOT EXISTS (SELECT 1 FROM execution_event_log p
                       WHERE p.scope_id = $1 AND p.version_hash = e.predecessor_hash)`,
    [scope_id],
  );
  if (Number(links[0]?.broken) > 0) fail('erase', 'chain broken after erase');
  pass('erase: payload blanked, chain intact');

  // 7. metrics snapshot + regression gate
  const snapshot = await takeSnapshot(
    (sql, params) => pool.query(sql, params as never),
    compression,
  );
  if (existsSync(SNAPSHOT_PATH)) {
    const prev = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as EvalSnapshot;
    const regressions = compareSnapshots(prev, snapshot);
    if (regressions.length > 0) {
      for (const r of regressions) console.error(`  ✗ regression: ${r}`);
      process.exit(1);
    }
    pass('regression gate', `vs snapshot ${prev.taken_at}`);
  } else {
    pass('regression gate', 'first snapshot (baseline established)');
  }
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  await pool.end();
  console.log('\njourney complete — all steps green');
}

main().catch((err) => {
  console.error('journey error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
