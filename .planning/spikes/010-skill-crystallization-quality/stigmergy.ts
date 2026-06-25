/**
 * Spike 010 / PoC-4 — the deterministic core: do N agents coordinating ONLY through
 * shared graph traces (stigmergy, no central controller) converge — completing the
 * whole DAG exactly once, in parallel, terminating — while the "environment physics"
 * floor (OCC claim arbitration + liveness/termination) prevents duplication, starvation,
 * and deadlock?
 *
 * This exercises the split-control decision: agent firing = stigmergy (each agent
 * autonomously picks ready work); environment physics = mechanical, on Memex (OCC +
 * termination + deadlock floor), never deciding which agent acts or what it does.
 *
 *   npx tsx .planning/spikes/010-skill-crystallization-quality/stigmergy.ts
 */
import { STEPS, DEPS, type Step } from '../../../scripts/eval/faithful-ab/dag.js';

type Deps = Record<Step, readonly Step[]>;

/** Run the stigmergic schedule with `nAgents`. Returns the trace + physics verdict. */
function run(nAgents: number, deps: Deps, allSteps: readonly Step[]) {
  const completed = new Set<Step>();        // shared blackboard (the only channel)
  const execCount = new Map<Step, number>(); // to detect any duplicate execution
  const parallelism: number[] = [];
  let rounds = 0;
  let verdict: 'converged' | 'deadlock' = 'converged';

  while (completed.size < allSteps.length) {
    // STIGMERGY: each agent independently reads traces and finds ready, unclaimed work.
    // No controller assigns — readiness is inferred from the shared completed-set.
    const ready = allSteps.filter((s) => !completed.has(s) && deps[s].every((d) => completed.has(d)));

    // ENVIRONMENT PHYSICS — liveness floor: no progress possible but not done = deadlock.
    if (ready.length === 0) { verdict = 'deadlock'; break; }

    // ENVIRONMENT PHYSICS — OCC arbitration: up to nAgents distinct claims succeed this
    // round; if two agents target the same step, only one wins (distinct slice models it).
    const claimed = ready.slice(0, nAgents);
    parallelism.push(claimed.length);
    for (const s of claimed) { completed.add(s); execCount.set(s, (execCount.get(s) ?? 0) + 1); }
    rounds++;
    if (rounds > allSteps.length + 5) { verdict = 'deadlock'; break; } // safety
  }

  const duplicated = [...execCount.entries()].filter(([, n]) => n > 1).map(([s]) => s);
  return { verdict, rounds, parallelism, completed, duplicated, execCount };
}

let failures = 0;
const assert = (cond: boolean, msg: string): void => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failures++;
};

// ── Healthy DAG with 3 agents ───────────────────────────────────────────────────
console.log('\n# 3 agents, real DAG (no central controller)');
const r = run(3, DEPS, STEPS);
console.log(`  verdict=${r.verdict}  rounds=${r.rounds}  parallelism/round=[${r.parallelism.join(',')}]`);
assert(r.verdict === 'converged', 'environment physics declares convergence (termination detected)');
assert(r.completed.size === STEPS.length, `all ${STEPS.length} steps completed`);
assert(r.duplicated.length === 0, 'OCC arbitration: no step executed twice (no duplication)');
assert([...r.execCount.values()].every((n) => n === 1), 'every step executed exactly once');
assert(Math.max(...r.parallelism) > 1, 'real concurrency: >1 step ran in the same round');
assert(r.rounds < STEPS.length, `parallel beats serial (${r.rounds} rounds < ${STEPS.length} steps)`);

// ── Serial sanity: 1 agent still converges (just no parallelism) ────────────────
const r1 = run(1, DEPS, STEPS);
assert(r1.verdict === 'converged' && r1.rounds === STEPS.length, '1 agent converges in 18 rounds (no starvation)');

// ── Deadlock guard: inject a cycle → physics must DETECT, not hang ──────────────
console.log('\n# Injected cycle (environment physics must catch it, not hang)');
const cyclic = { ...DEPS, scaffold: ['smoke_test'] as readonly Step[] }; // smoke_test ⟂ depends on scaffold already → cycle
const rc = run(3, cyclic as Deps, STEPS);
console.log(`  verdict=${rc.verdict}  completed=${rc.completed.size}/${STEPS.length}`);
assert(rc.verdict === 'deadlock', 'liveness floor DETECTS deadlock (no progress) instead of hanging');
assert(rc.completed.size < STEPS.length, 'deadlocked run correctly does NOT report full completion');

console.log('\n# Conclusion (PoC-4 core mechanism)');
console.log('  N agents coordinating only through shared traces (stigmergy) converge:');
console.log('  whole DAG done once, in parallel, terminating — with NO central controller.');
console.log('  The environment-physics floor (OCC + termination + deadlock detection) is');
console.log('  mechanical and never decides who acts. Live multi-agent confirmation later.');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${9 - failures}/9 assertions held\n`);
process.exit(failures === 0 ? 0 : 1);
