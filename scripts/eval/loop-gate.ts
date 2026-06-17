/**
 * Loop regression gate (GH #24). The emergence loop is a statistical LLM-in-the-loop
 * system: its correctness is BEHAVIORAL, not logical, so unit tests cannot catch a
 * regression in it (109 unit tests stayed green while a one-line crystallization-prompt
 * change collapsed the §5 curve from 38/0 to 121/52). This gate is the executable spec
 * of "the loop learns and holds it". Run it before changing any loop asset
 * (crystallization / merge / recall prompts or SQL, the reflect tiers, or the LLM model).
 *
 *   npm run eval:loop        # runs both curves, prints PASS/FAIL, exits non-zero on fail
 *
 * It loads LLM keys from .env (the harnesses read them from process.env), runs the two
 * faithful curves, and checks the validated criteria against the structured JSON each emits.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Inject .env LLM keys into the child env — the run.ts harnesses resolve ${VAR} from process.env. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, VITEST: '1' };
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^(LLM_[A-Z_]+|[A-Z0-9_]*API_KEY|[A-Z0-9_]*BASE_URL)\s*=\s*(.*)$/.exec(line);
      if (m && env[m[1]] === undefined) env[m[1]] = m[2].replace(/^["']|["']$/g, '').replace(/\r$/, '');
    }
  } catch { /* .env optional if keys already exported */ }
  if (!env.TEST_DB) env.TEST_DB = 'postgres://postgres:password@localhost:5432/graph_test';
  return env;
}

/** The newest curve-*.json in dir, written by the run we just executed. */
function newestCurve(dir: string): { summary: Record<string, number[]>; meta?: { model?: string } } {
  const full = join(ROOT, dir);
  const files = readdirSync(full).filter((f) => f.startsWith('curve-') && f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no curve JSON in ${dir}`);
  const newest = files.map((f) => ({ f, t: statSync(join(full, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]!.f;
  return JSON.parse(readFileSync(join(full, newest), 'utf8')) as {
    summary: Record<string, number[]>;
    meta?: { model?: string };
  };
}

const lastN = <T>(xs: T[], n: number): T[] => xs.slice(-n);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const intEnv = (name: string, d: number): number => {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : d;
};
const numEnv = (name: string, d: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : d;
};

interface Check { name: string; pass: boolean; detail: string }

function run(script: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`\n▶ ${script} ${args.join(' ')}`);
  execFileSync('npx', ['tsx', join(ROOT, script), ...args], { env, stdio: 'inherit', shell: process.platform === 'win32' });
}

/**
 * Statistical loop-regression gate (GH #24 → N1). The §5 18-step curve is BIMODAL
 * on a non-deterministic model: whether run-#1 crystallizes a good runbook largely
 * decides the whole curve (good → holds ~38-46; bad → every later run recalls the
 * bad runbook and collapses to ~121/TURN_CAP). So a SINGLE 10-run curve is ≈ one
 * Bernoulli trial — its absolute last-3 threshold cannot separate a bad DRAW from a
 * real REGRESSION (same-session master baseline collapsed identically to a changed
 * branch). The reproducibility literature says the fix is multi-sample + variance,
 * not single-seed thresholds ("A Sober Look at Progress in LM Reasoning", arXiv
 * 2504.07086; "Dissecting Non-Determinism", ICLR 2026 blog).
 *
 * So this gate runs the §5 curve K times and judges the COLLAPSE-RATE (fraction of
 * curves whose last-3 mean exceeds COLLAPSE_THRESHOLD) against a calibrated bar.
 * Knobs (env):
 *   EVAL_LOOP_CURVES         K independent §5 curves (default 1 = legacy quick check)
 *   EVAL_LOOP_RUNS           runs per curve (default 10)
 *   EVAL_LOOP_COLLAPSE_EVENTS  a curve "collapsed" if last-3 mean > this (default 80)
 *   EVAL_LOOP_MAX_COLLAPSE_RATE  pass if collapse-rate ≤ this. N2 measured the BASELINE
 *                            collapse-rate at ~0.55 (6/11 in-repo curves on gpt-oss-120b
 *                            collapse) — the loop is barely-better-than-coinflip at
 *                            baseline. Default 0.34 ≈ "must roughly halve the baseline
 *                            collapse rate" (a real improvement, not a lucky draw).
 *   EVAL_LOOP_MODEL_PIN      if set, every curve's meta.model must equal it, else FAIL
 *                            (effect size is model-dependent — never compare across models)
 */
function main(): void {
  const env = childEnv();
  const CURVES = intEnv('EVAL_LOOP_CURVES', 1);
  const RUNS = intEnv('EVAL_LOOP_RUNS', 10);
  const COLLAPSE_EVENTS = numEnv('EVAL_LOOP_COLLAPSE_EVENTS', 80);
  const MAX_COLLAPSE_RATE = numEnv('EVAL_LOOP_MAX_COLLAPSE_RATE', 0.34);
  const MODEL_PIN = process.env.EVAL_LOOP_MODEL_PIN;

  // §5 — microservice DAG, K independent curves → collapse-rate.
  const last3means: number[] = [];
  const models = new Set<string>();
  let collapsed = 0;
  for (let k = 0; k < CURVES; k++) {
    run('scripts/eval/faithful-ab/run.ts', ['curve', String(RUNS)], env);
    const c = newestCurve('.harness/analysis/faithful-ab');
    if (c.meta?.model) models.add(c.meta.model);
    const m = mean(lastN(c.summary.events_by_run, 3));
    last3means.push(Math.round(m));
    if (m > COLLAPSE_EVENTS) collapsed++;
    console.log(`  curve ${k + 1}/${CURVES}: last-3 mean ${m.toFixed(1)} ${m > COLLAPSE_EVENTS ? '✗ collapsed' : '✓ held'}`);
  }
  const collapseRate = collapsed / CURVES;
  const checks: Check[] = [
    {
      name: `§5 collapse-rate ≤ ${MAX_COLLAPSE_RATE} over ${CURVES} curve(s)`,
      pass: collapseRate <= MAX_COLLAPSE_RATE,
      detail: `collapse-rate ${collapseRate.toFixed(2)} (${collapsed}/${CURVES}; last-3 means ${last3means.join(',')})`,
    },
  ];
  if (MODEL_PIN !== undefined) {
    const off = [...models].filter((m) => m !== MODEL_PIN);
    checks.push({
      name: `§5 model pinned to ${MODEL_PIN}`,
      pass: off.length === 0,
      detail: off.length === 0 ? `all curves ran ${MODEL_PIN}` : `MISMATCH — ran ${[...models].join(',')}`,
    });
  } else {
    console.log(`  (model: ${[...models].join(',') || 'unknown'} — effect size is model-dependent; set EVAL_LOOP_MODEL_PIN to enforce)`);
  }

  // B2 — CLI precondition: the loop must learn "install before use" and stop the discovery failure.
  run('scripts/eval/cli-precondition/run.ts', [String(RUNS)], env);
  const b2 = newestCurve('.harness/analysis/cli-precondition').summary;
  const b2fails = lastN(b2.discoveryFailures_by_run, 3);
  checks.push({
    name: 'B2 learns the precondition (last-3 discovery failures = 0)',
    pass: b2fails.every((x) => x === 0),
    detail: `last-3 discovery failures ${b2fails.join(',')}`,
  });

  console.log('\n── loop regression gate (statistical) ──');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  const ok = checks.every((c) => c.pass);
  console.log(`\n${ok ? 'PASS — the loop learns and holds (within the collapse-rate bar).' : 'FAIL — collapse-rate over bar or model drift. Calibrate the bar vs baseline (N2) before concluding regression.'}`);
  process.exit(ok ? 0 : 1);
}

main();
