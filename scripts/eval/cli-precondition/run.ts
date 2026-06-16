/**
 * B2 experiment orchestrator (GH #24) — does the loop LEARN a real CLI precondition?
 *
 * Cold start (no templates), run the "use the s-cli tool" task N times with the FULL
 * loop (injection + crystallization + reinforcement). The CLI is reset to ABSENT
 * before every run, so the only thing that carries over is the crystallized lesson,
 * never the installed binary. Measures whether the discovery failure (a real
 * "command not found" from using the skill before installing it) disappears after the
 * loop crystallizes "install before use", and whether events-to-convergence drops.
 *
 *   VITEST=1 TEST_DB=...:graph_test <env LLM keys> \
 *     npx tsx scripts/eval/cli-precondition/run.ts [n]
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
import { resetCli } from './dag.js';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../.harness/analysis/cli-precondition');

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

function meta(model: string): Record<string, unknown> {
  let commit = 'unknown';
  try { commit = execSync('git rev-parse HEAD').toString().trim(); } catch { /* ignore */ }
  return { mode: 'curve', generated_at: new Date().toISOString(), commit, model, node: process.version };
}

function save(name: string, payload: unknown): string {
  mkdirSync(OUT_DIR, { recursive: true });
  const p = join(OUT_DIR, name);
  writeFileSync(p, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return p;
}

async function runCurve(deps: AgentDeps, runs: number, model: string): Promise<void> {
  // Hermetic cold start: wipe every memory tier (not just procedural), else accumulated
  // episodic/semantic from prior runs pollute recall and the curve stops being reproducible.
  await deps.pool.query(
    `TRUNCATE procedural_memory, episodic_memory, semantic_memory, working_memory, template_injection, embedding_backlog`,
  );
  const reader = new PoolTrailReader(deps.pool);
  const memory = new PoolMemoryRepository(deps.pool);
  const writer = new OccEventWriter(deps.pool);
  const crystallizer = new TemplateProposalWorker(reader, memory, writer, deps.llm, deps.embed);

  const records: RunRecord[] = [];
  for (let i = 0; i < runs; i++) {
    resetCli(); // every run starts with the CLI ABSENT — only the lesson persists
    const { rec, scopeId, head } = await runOnce(deps, `run#${i + 1}`, true);
    records.push(rec);
    if (rec.converged) {
      try { await crystallizer.onScopeClosed(scopeId, randomUUID(), head); } catch (e) { console.warn('crystallize failed:', (e as Error).message); }
    }
    const tpls = (await deps.pool.query<{ n: string }>(`SELECT count(*)::int n FROM procedural_memory WHERE is_anti_pattern = FALSE AND superseded_by IS NULL`)).rows[0]?.n;
    await cleanupScope(deps.pool, scopeId);
    console.log(`  run #${i + 1}: events=${rec.events} converged=${rec.converged} discoveryFails=${rec.discoveryFailures} installedFirst=${rec.installedFirst} recall=${rec.recallHit} canonical=${tpls}`);
  }
  resetCli();

  const third = Math.max(1, Math.floor(runs / 3));
  const firstE = stats(records.slice(0, third).map((r) => r.events));
  const lastE = stats(records.slice(-third).map((r) => r.events));
  const improvement = firstE.mean ? (firstE.mean - lastE.mean) / firstE.mean : 0;
  const summary = {
    runs,
    events_by_run: records.map((r) => r.events),
    discoveryFailures_by_run: records.map((r) => r.discoveryFailures),
    installedFirst_by_run: records.map((r) => r.installedFirst),
    first_third_events_mean: firstE.mean,
    last_third_events_mean: lastE.mean,
    improvement_pct: improvement,
  };
  const path = save(`curve-${Date.now()}.json`, { meta: meta(model), summary, records });
  console.log('\n── CLI-precondition learning curve ──');
  console.log(`events by run:           ${records.map((r) => r.events).join(', ')}`);
  console.log(`discovery failures:      ${records.map((r) => r.discoveryFailures).join(', ')}`);
  console.log(`installed before 1st use: ${records.map((r) => (r.installedFirst ? 'Y' : 'n')).join(', ')}`);
  console.log(`first-third events ${firstE.mean.toFixed(1)} → last-third ${lastE.mean.toFixed(1)}  (improvement ${(improvement * 100).toFixed(0)}%)\nsaved: ${path}`);
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? 8);
  const cs = process.env.TEST_DB ?? 'postgres://postgres:password@localhost:5432/graph_test';
  const pool = new Pool({ connectionString: cs, max: 4 });
  const { embed, llm } = await buildProviders();
  const model = (mergeLlmOverrides(loadMemexConfig(), readLlmOverrides())?.providers?.[0] as { model?: string })?.model ?? 'unknown';
  const { buildApp } = await import('@graph/gateway/index.js');
  const app = buildApp(pool, pool, 4096);
  const skill = await registerSkill(app);
  const deps: AgentDeps = { pool, embed, llm, app, skill };

  console.log(`\nB2 cli-precondition experiment — n=${n} model=${model}\n`);
  await runCurve(deps, n, model);
  await pool.end();
}

main().catch((e) => { console.error('run error:', e instanceof Error ? e.stack : e); process.exit(1); });
