/**
 * Faithful experiment orchestrator (GH #24). Two modes, both emitting a
 * structured JSON record for the benchmark paper:
 *
 *   ab    — ON/OFF injection A/B on the microservice-DAG task (direct-seeded
 *           golden template). Isolates injection -> efficiency.
 *   curve — "越用越聪明" learning curve: cold start (no templates), run the task
 *           N times with the FULL loop (injection + crystallization +
 *           reinforcement, all real post-#29). After each converged run the
 *           TemplateProposalWorker crystallizes a template the next run can
 *           recall. Measures whether events-to-convergence trends DOWN.
 *
 *   VITEST=1 TEST_DB=...:graph_test \
 *     <env LLM keys> npx tsx scripts/eval/faithful-ab/run.ts ab|curve [n]
 */
process.env.VITEST = process.env.VITEST ?? '1';

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { Pool } from 'pg';
import {
  buildEmbeddingProvider, buildChatProvider, loadMemexConfig, mergeLlmOverrides, readLlmOverrides,
  OccEventWriter, type EmbeddingProvider, type LLMProvider,
} from '@graph/shared';
import { PoolTrailReader } from '@graph/workers/base/trail-reader';
import { PoolMemoryRepository } from '@graph/workers/base/memory-repository';
import { TemplateProposalWorker } from '@graph/workers/memory/template-proposal.worker';
import { runOnce, cleanupScope, registerSkill, type RunRecord, type AgentDeps } from './agent.js';
import { seedGoldenTemplate, GOLDEN_SENTINEL } from './seed.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../.harness/analysis/faithful-ab');

function stats(xs: number[]): { mean: number; sd: number; min: number; max: number } {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  return { mean, sd, min: Math.min(...xs), max: Math.max(...xs) };
}

async function buildProviders(): Promise<{ embed: EmbeddingProvider | null; llm: LLMProvider }> {
  const config = mergeLlmOverrides(loadMemexConfig(), readLlmOverrides());
  let embed: EmbeddingProvider | null = buildEmbeddingProvider(config);
  const llm = buildChatProvider(config);
  if (!llm) { console.error('no chat provider (memex doctor / .env keys)'); process.exit(1); }
  if (embed) { try { await embed.embed('probe'); } catch { console.warn('embedding unavailable — degraded BM25 recall'); embed = null; } }
  return { embed, llm };
}

function meta(model: string, mode: string): Record<string, unknown> {
  let commit = 'unknown';
  try { commit = execSync('git rev-parse HEAD').toString().trim(); } catch { /* ignore */ }
  return { mode, generated_at: new Date().toISOString(), commit, model, node: process.version };
}

function save(name: string, payload: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const p = join(OUT_DIR, name);
  writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return p;
}

// ── A/B mode ─────────────────────────────────────────────────────────────────
async function runAB(deps: AgentDeps, reps: number, model: string): Promise<void> {
  await seedGoldenTemplate(deps.pool, deps.embed);
  const records: RunRecord[] = [];
  for (const arm of ['ON', 'OFF'] as const) {
    for (let i = 0; i < reps; i++) {
      const { rec, scopeId } = await runOnce(deps, `${arm}#${i + 1}`, arm === 'ON');
      await cleanupScope(deps.pool, scopeId);
      records.push(rec);
      console.log(`  ${arm} #${i + 1}: events=${rec.events} converged=${rec.converged} goal=${rec.goalAchieved} gateFails=${rec.gateFailures}${arm === 'ON' ? ` recall=${rec.recallHit}` : ''}`);
    }
  }
  const on = records.filter((r) => r.label.startsWith('ON'));
  const off = records.filter((r) => r.label.startsWith('OFF'));
  const onE = stats(on.map((r) => r.events));
  const offE = stats(off.map((r) => r.events));
  const delta = offE.mean ? (offE.mean - onE.mean) / offE.mean : 0;
  const summary = {
    reps,
    ON: { ...onE, gateFailures: stats(on.map((r) => r.gateFailures)).mean, convRate: on.filter((r) => r.converged).length / on.length, recallRate: on.filter((r) => r.recallHit).length / on.length },
    OFF: { ...offE, gateFailures: stats(off.map((r) => r.gateFailures)).mean, convRate: off.filter((r) => r.converged).length / off.length },
    delta_events_pct: delta,
  };
  const path = save(`ab-${Date.now()}.json`, { meta: meta(model, 'ab'), summary, records });
  console.log('\n── A/B summary ──');
  console.log(`ON  events ${onE.mean.toFixed(1)}±${onE.sd.toFixed(1)} [${onE.min}-${onE.max}]  gateFails=${summary.ON.gateFailures.toFixed(1)}  recall=${(summary.ON.recallRate * 100).toFixed(0)}%`);
  console.log(`OFF events ${offE.mean.toFixed(1)}±${offE.sd.toFixed(1)} [${offE.min}-${offE.max}]  gateFails=${summary.OFF.gateFailures.toFixed(1)}`);
  console.log(`delta (fewer events ON): ${(delta * 100).toFixed(0)}%\nsaved: ${path}`);
}

// ── Learning-curve mode ──────────────────────────────────────────────────────
async function runCurve(deps: AgentDeps, runs: number, model: string): Promise<void> {
  // cold start: wipe ALL procedural templates (no prior knowledge), incl. any seed
  await deps.pool.query(`DELETE FROM procedural_memory`);
  const reader = new PoolTrailReader(deps.pool);
  const memory = new PoolMemoryRepository(deps.pool);
  const writer = new OccEventWriter(deps.pool);
  const crystallizer = new TemplateProposalWorker(reader, memory, writer, deps.llm, deps.embed);

  const records: RunRecord[] = [];
  for (let i = 0; i < runs; i++) {
    const { rec, scopeId, head } = await runOnce(deps, `run#${i + 1}`, true); // full loop: injection ON
    records.push(rec);
    if (rec.converged) {
      // crystallize this converged run into a template the next run can recall
      try { await crystallizer.onScopeClosed(scopeId, randomUUID(), head); } catch (e) { console.warn('crystallize failed:', (e as Error).message); }
    }
    const tpls = (await deps.pool.query<{ n: string }>(`SELECT count(*)::int n FROM procedural_memory WHERE is_anti_pattern = FALSE`)).rows[0]?.n;
    await cleanupScope(deps.pool, scopeId);
    console.log(`  run #${i + 1}: events=${rec.events} converged=${rec.converged} gateFails=${rec.gateFailures} recall=${rec.recallHit} templates=${tpls}`);
  }
  const first = stats(records.slice(0, Math.max(1, Math.floor(runs / 3))).map((r) => r.events));
  const last = stats(records.slice(-Math.max(1, Math.floor(runs / 3))).map((r) => r.events));
  const improvement = first.mean ? (first.mean - last.mean) / first.mean : 0;
  const summary = { runs, events_by_run: records.map((r) => r.events), gateFailures_by_run: records.map((r) => r.gateFailures), first_third_mean: first.mean, last_third_mean: last.mean, improvement_pct: improvement };
  const path = save(`curve-${Date.now()}.json`, { meta: meta(model, 'curve'), summary, records });
  console.log('\n── learning curve ──');
  console.log(`events by run: ${records.map((r) => r.events).join(', ')}`);
  console.log(`first-third mean ${first.mean.toFixed(1)} → last-third mean ${last.mean.toFixed(1)}  (improvement ${(improvement * 100).toFixed(0)}%)\nsaved: ${path}`);
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'ab';
  const n = Number(process.argv[3] ?? (mode === 'curve' ? 8 : 8));
  const cs = process.env.TEST_DB ?? 'postgres://postgres:password@localhost:5432/graph_test';
  const pool = new Pool({ connectionString: cs, max: 4 });
  const { embed, llm } = await buildProviders();
  const model = (mergeLlmOverrides(loadMemexConfig(), readLlmOverrides())?.providers?.[0] as { model?: string })?.model ?? 'unknown';
  const { buildApp } = await import('@graph/gateway/index.js');
  const app = buildApp(pool, pool, 4096);
  const skill = await registerSkill(app);
  const deps: AgentDeps = { pool, embed, llm, app, skill };

  console.log(`\nfaithful experiment — mode=${mode} n=${n} model=${model}\n`);
  if (mode === 'ab') await runAB(deps, n, model);
  else if (mode === 'curve') await runCurve(deps, n, model);
  else { console.error(`unknown mode ${mode}`); process.exit(1); }

  await pool.query(`DELETE FROM procedural_memory WHERE source_scope_id = $1`, [GOLDEN_SENTINEL]).catch(() => {});
  await pool.end();
}

main().catch((e) => { console.error('run error:', e instanceof Error ? e.stack : e); process.exit(1); });
