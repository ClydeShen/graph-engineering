/**
 * Freshness-substrate calibration constants (GH #30–#35).
 *
 * The emergence loop is a non-deterministic LLM-in-the-loop system; its own
 * benchmark lesson (docs/benchmarks/emergence-loop-validation.md §5.7) is that a
 * loop's thresholds must be FIT FROM DATA, not guessed. So every freshness dial
 * lives here, env-overridable, with a documented provisional default — the clean
 * re-run (#35) fits the real values and writes them back without touching code.
 *
 * "The system owns ingredient freshness, and only that." These constants govern
 * how per-crystallization trust (quality_score = Laplace(success,failure)) is
 * earned and lost — never how the LLM composes ingredients into a workflow
 * (cooking, out of scope).
 *
 * SAFE-DEFAULT POLICY: defaults are behaviour-preserving or strictly more
 * conservative than the blind pre-#30 path (soften fewer, only the at-fault
 * ingredient; harden only the conformant). They keep `npm run eval:loop` green;
 * #35 turns the dials up against the curve.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

export const FRESHNESS = {
  /**
   * P1 soften — `failure_count` increment applied to a CONFORMED + failed
   * template (its prescribed order was followed, yet the scope did not converge:
   * the ingredient is implicated). Provisional +1, mirroring the pre-#30 blind
   * penalty, but now per-template and only on conformance. "Fast soften."
   */
  softenIncrement: num('FRESHNESS_SOFTEN_INCREMENT', 1),

  /**
   * P1 harden — base `success_count` credit for a CONFORMANT template on
   * convergence. Token-efficiency grading scales this between
   * [hardenCreditMin, hardenCreditBase]: the simpler (fewer events) the cooking
   * that still won, the stronger the ingredient credit. "Slow harden."
   */
  hardenCreditBase: num('FRESHNESS_HARDEN_CREDIT_BASE', 1),
  hardenCreditMin: num('FRESHNESS_HARDEN_CREDIT_MIN', 1),

  /**
   * Token-efficiency grading reference: the events-to-converge at or below which
   * a run counts as maximally efficient (full hardenCreditBase). Above
   * hardenEfficiencyCeil the credit floors at hardenCreditMin. Provisional band
   * matches the validated ~38-46 optimum / ~60 TURN_CAP of the §5 curve.
   * Defaults equal → grading is a no-op (base credit) until #35 fits the band.
   */
  hardenEfficiencyFloor: num('FRESHNESS_HARDEN_EFFICIENCY_FLOOR', 0),
  hardenEfficiencyCeil: num('FRESHNESS_HARDEN_EFFICIENCY_CEIL', 0),

  /**
   * Conformance tolerance — the fraction of APPLICABLE prescribed ordering rules
   * a scope may violate and still count as "conformed". 0 = exact (any violation
   * → violated). Raise toward partial-order leniency in #35 if exact proves brittle.
   */
  conformanceMaxViolationRatio: num('FRESHNESS_CONFORMANCE_MAX_VIOLATION_RATIO', 0),

  /**
   * P2 metabolism — apoptosis evidence bands (read by the cron sweep).
   *   n_min: minimum evidence volume (success+failure) below which evidence is
   *          "thin" → triage, never auto-retire.
   *   qualityBad: quality_score at/below which a well-evidenced template is
   *               proven-bad → metabolize (superseded_by=id).
   *   qualityGood: quality_score at/above which a well-evidenced template is
   *                proven-good → keep/harden.
   *   The (qualityBad, qualityGood) open interval is the ambiguous middle →
   *   surface to human triage with success-rate shown. Laplace already gives
   *   volume-sensitivity for free.
   */
  metabolismNMin: num('FRESHNESS_METABOLISM_N_MIN', 5),
  metabolismQualityBad: num('FRESHNESS_METABOLISM_QUALITY_BAD', 0.3),
  metabolismQualityGood: num('FRESHNESS_METABOLISM_QUALITY_GOOD', 0.7),

  /**
   * P3 mid-flight gate — a plan rests on "confidently-good" ingredients when
   * every non-cold injected template clears BOTH quality and evidence floors.
   * gateQualityFloor reuses P2's good band by default (one boundary, two
   * read-times — confirm or split in #35). gateEvidenceFloor reuses n_min.
   */
  gateQualityFloor: num('FRESHNESS_GATE_QUALITY_FLOOR', 0.7),
  gateEvidenceFloor: num('FRESHNESS_GATE_EVIDENCE_FLOOR', 5),
} as const;

export type FreshnessConfig = typeof FRESHNESS;
