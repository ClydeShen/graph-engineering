/**
 * Spike 010 / PoC-1 — the deterministic core: WHY an executable step-DAG runbook is
 * more robust than a free-form text Lesson.
 *
 * The robustness lever is NOT "the LLM distils better prose". It is that a typed
 * step-DAG is **machine-verifiable at crystallization time** against the real
 * dependency DAG, so a corrupted/hallucinated rule is rejected UPSTREAM — whereas a
 * text Lesson carrying the same corruption passes silently (no checkable structure).
 *
 * This file proves that asymmetry deterministically, no live LLM required. The
 * statistical efficacy (variance across N real runs via eval:loop) is the heavier
 * step-2 confirmation that needs the live harness.
 *
 *   npx tsx .planning/spikes/010-skill-crystallization-quality/step-dag.ts
 */
import { STEPS, DEPS, GOLDEN_ORDER, GOLDEN_INTENT, type Step } from '../../../scripts/eval/faithful-ab/dag.js';

// ── The two crystallized forms under test ──────────────────────────────────────

/** Baseline (today): free-form prose. The crystallizer emits a string like GOLDEN_INTENT. */
type TextLessonRunbook = { kind: 'text-lesson'; intent: string };

/** §3 proposal: a typed, replayable, machine-assertable step-DAG. */
type StepDagRunbook = {
  kind: 'step-dag';
  order: Step[];
  /** salient ordering rules (the recall hints), each "a before b". */
  constraints: Array<[Step, Step]>;
};

// ── Verification (the lever) ────────────────────────────────────────────────────

function ancestors(step: Step, deps: typeof DEPS): Set<Step> {
  const seen = new Set<Step>();
  const stack = [...deps[step]];
  while (stack.length) {
    const s = stack.pop()!;
    if (seen.has(s)) continue;
    seen.add(s);
    stack.push(...deps[s]);
  }
  return seen;
}

/** A step-DAG runbook CAN be checked against the real DAG. Returns violations (empty = ok). */
function verifyStepDag(rb: StepDagRunbook, deps: typeof DEPS): string[] {
  const v: string[] = [];
  const pos = new Map(rb.order.map((s, i) => [s, i] as const));
  // (1) completeness: every step present exactly once
  if (rb.order.length !== STEPS.length || new Set(rb.order).size !== STEPS.length) {
    v.push(`order is not a permutation of the ${STEPS.length} steps`);
  }
  // (2) the claimed order must be a valid topological order of the real DAG
  for (const step of rb.order) {
    for (const dep of deps[step] ?? []) {
      if (!pos.has(dep) || pos.get(dep)! > pos.get(step)!) {
        v.push(`order: "${step}" scheduled before its prerequisite "${dep}"`);
      }
    }
  }
  // (3) each stated rule "a before b" must not contradict the DAG (b a prereq of a)
  for (const [a, b] of rb.constraints) {
    if (ancestors(a, deps).has(b)) {
      v.push(`rule: "${a} before ${b}" contradicts the DAG ("${b}" is a prerequisite of "${a}")`);
    }
  }
  return v;
}

/**
 * A text Lesson cannot be verified against the DAG without NLP — there is no
 * checkable structure. The crystallizer has no upstream gate; corruption is kept.
 */
function verifyTextLesson(_rb: TextLessonRunbook): { checkable: false } {
  return { checkable: false };
}

// ── Demonstration ───────────────────────────────────────────────────────────────

let failures = 0;
const assert = (cond: boolean, msg: string): void => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failures++;
};

const SIX_RULES: Array<[Step, Step]> = [
  ['write_api', 'db_schema'], ['write_tests', 'lint'], ['security_scan', 'containerize'],
  ['build_image', 'run_tests'], ['run_tests', 'run_migrations'], ['deploy', 'setup_monitoring'],
];

console.log('\n# A — a CORRECT crystallization passes both forms');
const goodDag: StepDagRunbook = { kind: 'step-dag', order: [...GOLDEN_ORDER], constraints: SIX_RULES };
const goodText: TextLessonRunbook = { kind: 'text-lesson', intent: GOLDEN_INTENT };
assert(verifyStepDag(goodDag, DEPS).length === 0, 'step-DAG: golden runbook verifies clean');
assert(verifyTextLesson(goodText).checkable === false, 'text-lesson: not machine-checkable (passes by default)');

console.log('\n# B — a CORRUPTED crystallization (one reversed rule flipped wrong)');
// Corrupt Q1: claim db_schema before write_api — contradicts the DAG.
const badOrder = [...GOLDEN_ORDER];
const iApi = badOrder.indexOf('write_api'), iSchema = badOrder.indexOf('db_schema');
[badOrder[iApi], badOrder[iSchema]] = [badOrder[iSchema]!, badOrder[iApi]!];
const badDag: StepDagRunbook = {
  kind: 'step-dag', order: badOrder,
  constraints: [['db_schema', 'write_api'], ...SIX_RULES.slice(1)],
};
const badText: TextLessonRunbook = {
  kind: 'text-lesson',
  intent: GOLDEN_INTENT.replace('write_api before db_schema', 'db_schema before write_api'),
};
const dagViolations = verifyStepDag(badDag, DEPS);
console.log('   step-DAG violations caught:\n     - ' + dagViolations.join('\n     - '));
assert(dagViolations.length > 0, 'step-DAG: corruption REJECTED upstream (crystallization gate fires)');
assert(verifyTextLesson(badText).checkable === false,
  'text-lesson: SAME corruption passes silently (no upstream gate)');

console.log('\n# Conclusion (PoC-1 core mechanism)');
console.log('  The executable step-DAG form is verifiable-at-crystallization-time;');
console.log('  the text-Lesson form is not. That verifiability is the robustness lever —');
console.log('  it converts "store an incorrect lesson" (the prior arc\'s death) into a');
console.log('  rejectable event. Statistical confirmation = step-2 (eval:loop, live env).');

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${4 - failures}/4 assertions held\n`);
process.exit(failures === 0 ? 0 : 1);
