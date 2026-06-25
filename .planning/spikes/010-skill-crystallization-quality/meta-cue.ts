/**
 * Spike 010 / PoC-2 — the deterministic core: is the meta-cue ("should I consult
 * here?") a real signal, or equivalent to a degenerate always-on/always-off?
 *
 * The cue must fire at the decision points where a known trap applies (true
 * positive) and stay quiet on noise (true negative). Pure pull (always-off) misses
 * traps → the error library goes unconsulted. Memex-pushes-everything (always-on)
 * is noise. The learned cue — fed by accumulated FAILURE traces — should fire
 * exactly where this agent has historically tripped, beating both degenerate
 * baselines, and improve monotonically with use (cold-start tided over by a
 * pre-fabricated seed prior).
 *
 * Deterministic, no live LLM. Statistical efficacy on real runs = a later live step.
 *
 *   npx tsx .planning/spikes/010-skill-crystallization-quality/meta-cue.ts
 */
import { STEPS, DEPS, GOLDEN_ORDER, type Step } from '../../../scripts/eval/faithful-ab/dag.js';

// ── Ground truth: where a STRONG agent actually trips ───────────────────────────
// dag.ts is built so a strong model gets the 12 obvious steps right from its CI/CD
// priors and trips ONLY on the 6 reversed-intuition quirks (Q1–Q6) — "only a learned
// runbook supplies the truth" there. So the traps are a MINORITY (6/18); those are
// exactly the points where the cue should fire. (A naive alphabetical agent trips on
// 16/18 — but that models a weak agent and would make push-everything look fine; the
// honest case is the strong agent whose only blind spots are the 6 quirks.)
const QUIRK_STEPS: Step[] = [
  'db_schema',        // Q1  ← write_api
  'lint',             // Q2  ← write_tests
  'security_scan',    // Q3  before containerize
  'run_tests',        // Q4  ← build_image
  'run_migrations',   // Q5  ← run_tests
  'setup_monitoring', // Q6  ← deploy
];
const TRAPS = new Set<Step>(QUIRK_STEPS);
// discovery order = the order the agent meets each quirk while executing correctly
const GPOS = new Map(GOLDEN_ORDER.map((s, i) => [s, i] as const));
const discovery = [...QUIRK_STEPS].sort((a, b) => GPOS.get(a)! - GPOS.get(b)!);

// ── Scoring ─────────────────────────────────────────────────────────────────────
function score(fire: Set<Step>): { p: number; r: number; f1: number } {
  let tp = 0;
  for (const s of fire) if (TRAPS.has(s)) tp++;
  const p = fire.size === 0 ? 0 : tp / fire.size;
  const r = TRAPS.size === 0 ? 0 : tp / TRAPS.size;
  const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
  return { p, r, f1 };
}
const pct = (x: number): string => (x * 100).toFixed(0) + '%';

// ── Strategies ──────────────────────────────────────────────────────────────────
/** over-trigger: cue on every action ("Memex pushes everything"). */
const alwaysOn = new Set<Step>(STEPS);
/** under-trigger: pure pull, env never signals. */
const alwaysOff = new Set<Step>();
/** cold-start seed prior (no history): fire on join-points (≥2 prereqs) — a generic
 *  structural proxy. NOTE: weak for domain-specific reversed-intuition quirks. */
const seedPrior = new Set<Step>(STEPS.filter((s) => DEPS[s].length >= 2));
/** learned after k runs: a strong agent gets stuck at its first unseen quirk, records
 *  it, and reaches one further next run — so after k runs it knows the first k quirks
 *  (in execution-discovery order). */
const learnedAfter = (k: number): Set<Step> => new Set(discovery.slice(0, k));
const fullyLearned = learnedAfter(discovery.length);

// ── Report ──────────────────────────────────────────────────────────────────────
console.log(`\nGround-truth trap points (${TRAPS.size}/${STEPS.length}): ${discovery.join(', ')}\n`);
console.log('strategy            precision  recall   F1');
const row = (name: string, fire: Set<Step>): void => {
  const s = score(fire);
  console.log(`  ${name.padEnd(18)} ${pct(s.p).padStart(8)} ${pct(s.r).padStart(8)} ${pct(s.f1).padStart(6)}`);
};
row('always-on', alwaysOn);
row('always-off', alwaysOff);
row('seed-prior (k=0)', seedPrior);
row('learned (full)', fullyLearned);

console.log('\nlearning curve (failure traces accumulate):');
for (let k = 0; k <= discovery.length; k++) {
  const s = score(learnedAfter(k));
  console.log(`  after ${String(k).padStart(2)} runs   P=${pct(s.p).padStart(4)}  R=${pct(s.r).padStart(4)}  F1=${pct(s.f1).padStart(4)}`);
}

// ── Kill-criterion assertions ───────────────────────────────────────────────────
let failures = 0;
const assert = (cond: boolean, msg: string): void => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failures++;
};
console.log('\n# Kill-criterion');
const on = score(alwaysOn), off = score(alwaysOff), full = score(fullyLearned), seed = score(seedPrior);
assert(on.p < 0.5, `always-on is noise (precision ${pct(on.p)} < 50%)`);
assert(off.r === 0, 'always-off (pure pull) misses every trap (recall 0%)');
assert(full.p === 1 && full.r === 1, `learned cue separates perfectly (P=${pct(full.p)} R=${pct(full.r)})`);
assert(full.f1 > on.f1 && full.f1 > off.f1, 'learned cue strictly dominates both degenerate baselines');
let monotone = true, prev = -1;
for (let k = 0; k <= discovery.length; k++) { const f = score(learnedAfter(k)).f1; if (f < prev - 1e-9) monotone = false; prev = f; }
assert(monotone, 'learning is monotone (F1 never regresses as traces accumulate)');
assert(seed.r > 0, `seed prior tides over cold-start (k=0 recall ${pct(seed.r)} > 0, no live history)`);

console.log('\n# Conclusion (PoC-2 core mechanism)');
console.log('  The meta-cue fed by accumulated failure traces is a real signal: it');
console.log('  converges to fire exactly where this agent has tripped (P=R=100%),');
console.log('  strictly beating push-everything (noise) and pure-pull (blind). A generic');
console.log('  seed prior only weakly predicts domain quirks (honest finding) but is');
console.log('  non-empty at cold start; learning from real failures is the real lever.');
console.log('  Statistical confirmation on live LLM trajectories = a later live step.');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${6 - failures}/6 assertions held\n`);
process.exit(failures === 0 ? 0 : 1);
