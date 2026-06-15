/**
 * Realistic long task — "stand up a new microservice" (GH #24 faithful A/B).
 *
 * 11 steps with a real dependency DAG. Most edges are intuitive (scaffold first,
 * deploy last); two are NON-OBVIOUS project quirks that an agent cannot infer
 * from names and that only a learned runbook (the golden template) carries:
 *   Q1: run_tests depends on containerize  — tests run INSIDE the container
 *   Q2: gen_migrations depends on add_deps — the migration tool is a dependency
 *
 * The goal lists the steps alphabetically (no order leaked). An agent that
 * respects only the intuitive deps still trips Q1/Q2 → gate failure → rework.
 * The injected runbook encodes the full topological order incl. the quirks.
 */

export const STEPS = [
  'scaffold', 'add_deps', 'db_schema', 'start_db', 'write_api',
  'gen_migrations', 'write_tests', 'containerize', 'run_migrations',
  'run_tests', 'deploy',
] as const;
export type Step = (typeof STEPS)[number];

/** dep edges: a step is READY only when all its prerequisites are completed. */
export const DEPS: Record<Step, readonly Step[]> = {
  scaffold: [],
  add_deps: ['scaffold'],
  db_schema: ['scaffold'],
  start_db: ['scaffold'],
  write_api: ['add_deps', 'db_schema'],
  gen_migrations: ['db_schema', 'add_deps'], // Q2: add_deps is the non-obvious one
  write_tests: ['write_api'],
  containerize: ['write_api'],
  run_migrations: ['gen_migrations', 'start_db'],
  run_tests: ['run_migrations', 'write_tests', 'containerize'], // Q1: containerize non-obvious
  deploy: ['run_tests'],
};

/** A correct topological order (what the golden runbook teaches). */
export const GOLDEN_ORDER: readonly Step[] = [
  'scaffold', 'add_deps', 'db_schema', 'start_db', 'write_api',
  'gen_migrations', 'containerize', 'write_tests', 'run_migrations',
  'run_tests', 'deploy',
];

export function isReady(step: Step, completed: ReadonlySet<Step>): boolean {
  return DEPS[step].every((d) => completed.has(d));
}

/** Unmet prerequisites for a step — used in the failure message. */
export function missingDeps(step: Step, completed: ReadonlySet<Step>): Step[] {
  return DEPS[step].filter((d) => !completed.has(d));
}

/** Goal text — lists steps ALPHABETICALLY, never reveals the dep graph. */
export const GOAL_TEXT =
  'Stand up a new microservice. Complete every one of these build steps exactly ' +
  'once: ' + [...STEPS].sort().join(', ') + '. Some steps depend on others being ' +
  'done first; a step attempted before its prerequisites will fail. Respond with ONE action.';

/** The learned runbook the golden template carries (the recalled shortcut). */
export const GOLDEN_INTENT =
  'Runbook to stand up a microservice. Correct build order: ' +
  GOLDEN_ORDER.join(' -> ') + '. Note two non-obvious prerequisites: run_tests ' +
  'requires containerize first (tests run inside the container); gen_migrations ' +
  'requires add_deps first (the migration tool is a project dependency).';
