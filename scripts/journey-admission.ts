/**
 * Live sanity check for experiment A's independent admission verifier.
 * Asserts the deterministic ground-truth DAG check rejects a runbook that replays
 * a cold-start mistake (a rule contradicting the dependency graph) and admits the
 * golden runbook (all rules consistent with the graph). Pure/in-process — no DB.
 * Run: npx tsx scripts/journey-admission.ts
 */
import { runbookContradictsDag } from './eval/faithful-ab/admission.js';
import { GOLDEN_INTENT } from './eval/faithful-ab/dag.js';

function main(): void {
  const fail = (m: string): never => { throw new Error('ADMISSION FAIL: ' + m); };

  // Bad: replays the documented collapse driver. run_tests transitively depends on
  // containerize (containerize → build_image → run_tests), so "run_tests before
  // containerize" contradicts ground truth → must be rejected.
  const bad = 'Runbook: run_tests must be done before containerize. Then deploy.';
  if (!runbookContradictsDag(bad)) fail('did NOT reject a DAG-contradicting runbook (run_tests before containerize)');
  console.log('  ✓ rejected DAG-contradicting runbook (run_tests before containerize)');

  // A second contradiction form: explicit chain that reverses a real dependency
  // (db_schema actually depends on write_api → "db_schema -> write_api" is wrong).
  const badChain = 'Correct order: db_schema -> write_api -> deploy.';
  if (!runbookContradictsDag(badChain)) fail('did NOT reject a contradictory order chain (db_schema -> write_api)');
  console.log('  ✓ rejected contradictory order chain (db_schema -> write_api)');

  // Good: the golden runbook's rules are all consistent with the DAG → admitted.
  if (runbookContradictsDag(GOLDEN_INTENT)) fail('rejected the GOLDEN runbook (its rules are all DAG-consistent)');
  console.log('  ✓ admitted the golden runbook (all rules DAG-consistent)');

  console.log('\nADMISSION PASS — independent DAG verifier rejects contradictions, admits the truth');
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
