/**
 * Independent admission verifier (experiment A — "independent verifier loop").
 *
 * The freshness arc settled a negative result: no DOWNSTREAM trust signal beats
 * the ~0.55 baseline collapse-rate, because every signal is derived from the same
 * loop that produced the crystallization — generator == verifier, so the
 * generation-verification gap collapses to zero (Mind the Gap, ICLR 2025;
 * Multi-Agent Verification, arXiv 2502.20379). The escape the literature points
 * to is an INDEPENDENT verifier — judge the crystallization with a process that
 * did NOT produce it, and reject the bad ones at ADMISSION (upstream) instead of
 * re-weighting them after they are already in memory (downstream).
 *
 * This is the cheapest possible independent verifier: a pure, deterministic check
 * of the proposed runbook's prescribed ordering against the task's GROUND-TRUTH
 * dependency DAG (dag.ts). It is independent by construction — it reads the graph,
 * not the LLM's opinion of the graph. It isolates a single variable (independence)
 * with zero model confound; the production-general version (a second LLM, or graph
 * topology across scopes) is the next rung, gated on this one beating baseline.
 *
 * Benchmark-only: the ground-truth DAG exists here, not in production. The seam it
 * drives (TemplateProposalWorker's optional admitRunbook) is default-off, so
 * production behaviour is byte-identical.
 */
import { parseOrderingRules } from '@graph/workers/memory/conformance.js';
import { DEPS, STEPS, type Step } from './dag.js';

/**
 * Transitive prerequisites (ancestors) of each step from the ground-truth DEPS.
 * `ancestors(s)` = every step that MUST precede `s` in any valid execution.
 */
function buildAncestors(): Map<string, Set<string>> {
  const anc = new Map<string, Set<string>>();
  const visit = (s: Step): Set<string> => {
    const cached = anc.get(s);
    if (cached) return cached;
    const set = new Set<string>();
    anc.set(s, set); // set before recursion (DAG, no cycles, but safe)
    for (const dep of DEPS[s]) {
      set.add(dep);
      for (const a of visit(dep)) set.add(a);
    }
    return set;
  };
  for (const s of STEPS) visit(s);
  return anc;
}

const ANCESTORS = buildAncestors();
const VOCAB: readonly string[] = STEPS;

/**
 * Does the crystallized runbook prescribe an order that CONTRADICTS ground truth?
 *
 * A prescribed rule {before: X, after: Y} ("X must precede Y") contradicts the DAG
 * iff the DAG requires Y before X — i.e. Y is a transitive prerequisite of X
 * (Y ∈ ancestors(X)). Example: a runbook that replays a cold-start mistake as
 * "run_tests before containerize" is rejected, because containerize ∈
 * ancestors(run_tests). Rules are parsed by the SAME deterministic scanner the
 * conformance comparator uses (no LLM), grounded in the DAG step vocabulary.
 */
export function runbookContradictsDag(runbook: string): boolean {
  const rules = parseOrderingRules(runbook, VOCAB);
  for (const r of rules) {
    if (ANCESTORS.get(r.before)?.has(r.after)) return true;
  }
  return false;
}

/**
 * Admission predicate for TemplateProposalWorker's optional seam: admit the
 * crystallization unless it contradicts the ground-truth DAG. Logs rejections so
 * the curve makes the upstream filtering visible.
 */
export function admitRunbook(runbook: string): boolean {
  if (runbookContradictsDag(runbook)) {
    console.log('  [admission] rejected DAG-contradicting crystallization (kept out of memory)');
    return false;
  }
  return true;
}
