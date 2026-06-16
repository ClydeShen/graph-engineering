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
function newestCurve(dir: string): { summary: Record<string, number[]> } {
  const full = join(ROOT, dir);
  const files = readdirSync(full).filter((f) => f.startsWith('curve-') && f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no curve JSON in ${dir}`);
  const newest = files.map((f) => ({ f, t: statSync(join(full, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]!.f;
  return JSON.parse(readFileSync(join(full, newest), 'utf8')) as { summary: Record<string, number[]> };
}

const lastN = <T>(xs: T[], n: number): T[] => xs.slice(-n);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

interface Check { name: string; pass: boolean; detail: string }

function run(script: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`\n▶ ${script} ${args.join(' ')}`);
  execFileSync('npx', ['tsx', join(ROOT, script), ...args], { env, stdio: 'inherit', shell: process.platform === 'win32' });
}

function main(): void {
  const env = childEnv();

  // §5 — microservice DAG: the loop must drive the 18-step curve to the optimum and HOLD it.
  run('scripts/eval/faithful-ab/run.ts', ['curve', '10'], env);
  const s5 = newestCurve('.harness/analysis/faithful-ab').summary;
  // The loop runs on a non-deterministic model (temp=0 still varies), so the gate is
  // STATISTICAL: it asserts the loop converges and does NOT collapse, not an exact 38/0.
  // The validated working band is ~38-46 events; a regressed loop collapses to ~100-121
  // (TURN_CAP) when a corrupted/absent runbook misleads the agent. These thresholds cleanly
  // separate the two and tolerate single-shot completeness variance.
  const s5events = lastN(s5.events_by_run, 3);
  const checks: Check[] = [
    {
      name: '§5 does not collapse (last-3 events all < 80)',
      pass: Math.max(...s5events) < 80,
      detail: `last-3 events ${s5events.join(',')} (max ${Math.max(...s5events)})`,
    },
    {
      name: '§5 converges near optimum (last-3 mean ≤ 50)',
      pass: mean(s5events) <= 50,
      detail: `last-3 events ${s5events.join(',')} (mean ${mean(s5events).toFixed(1)})`,
    },
  ];

  // B2 — CLI precondition: the loop must learn "install before use" and stop the discovery failure.
  run('scripts/eval/cli-precondition/run.ts', ['10'], env);
  const b2 = newestCurve('.harness/analysis/cli-precondition').summary;
  const b2fails = lastN(b2.discoveryFailures_by_run, 3);
  checks.push({
    name: 'B2 learns the precondition (last-3 discovery failures = 0)',
    pass: b2fails.every((x) => x === 0),
    detail: `last-3 discovery failures ${b2fails.join(',')}`,
  });

  console.log('\n── loop regression gate ──');
  for (const c of checks) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);
  const ok = checks.every((c) => c.pass);
  console.log(`\n${ok ? 'PASS — the loop learns and holds. Safe to change loop assets.' : 'FAIL — a loop asset regressed. Do NOT ship this change.'}`);
  process.exit(ok ? 0 : 1);
}

main();
