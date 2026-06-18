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

  /**
   * N5 — recency-weighted trust (late-drift fix). EWMA discount on each
   * harden/soften: recent_quality = (1-α)·recent_quality + α·outcome (1=converged,
   * 0=conformed-failure). Higher α = faster reaction to recent change. Apoptosis
   * reads recent_quality (not cumulative Laplace) for its bad-band test, so a
   * once-good template that drifts bad is retired. Research: discounted/sliding-
   * window UCB is near-optimal for non-stationary reward (Garivier & Moulines).
   * α is calibration-deferred (N6).
   */
  recencyAlpha: num('FRESHNESS_RECENCY_ALPHA', 0.4),

  /**
   * Lever 2 (from N6) — outcome-streak circuit-breaker. A template recalled into
   * `recallFailStreakRetire` CONSECUTIVE non-convergent scopes is retired
   * (reversible), regardless of conformance, so the loop cold-starts and escapes a
   * deterministic collapse (covers cooking-caused collapse the trust signal can't).
   * 0 = DISABLED (default — preserves validated production behaviour; the
   * experiment turns it on). NOT a trust verdict; recent_quality stays
   * conformance-honest. Calibration-deferred (must be power-validated, ≥10 curves).
   */
  recallFailStreakRetire: num('FRESHNESS_RECALL_FAIL_STREAK', 0),

  /**
   * Prevention lever (from N7) — topology-corroboration admission control. A
   * crystallization is recalled at full weight only once its WL topology has been
   * independently RE-DERIVED >= this many times (corroboration_count). This LOADS
   * the crystallization lottery (recall only corroborated runbooks) rather than
   * re-rolling it, the one thing retirement structurally cannot do. 0 = DISABLED
   * (default — recall filter becomes `corroboration_count >= 0`, byte-identical to
   * current behaviour). Calibration-deferred (must be power-validated A/B).
   */
  recallPromoteThreshold: num('FRESHNESS_RECALL_PROMOTE_THRESHOLD', 0),
} as const;

export type FreshnessConfig = typeof FRESHNESS;

/**
 * Token-efficiency grading (GH #31): map a converged scope's events-to-converge
 * to a harden credit in [hardenCreditMin, hardenCreditBase]. The fewer events it
 * took (the simpler the cooking that still won), the stronger the ingredient
 * credit — rewarding ingredients that let minimal cooking succeed.
 *
 * Disabled by default (floor==ceil → always hardenCreditBase) until #35 fits the
 * band from the clean re-run. `success_count` is INT, so the caller rounds.
 */
export function gradeHardenCredit(eventsToConverge: number): number {
  const { hardenCreditBase, hardenCreditMin, hardenEfficiencyFloor, hardenEfficiencyCeil } = FRESHNESS;
  if (hardenEfficiencyCeil <= hardenEfficiencyFloor) return hardenCreditBase; // grading off
  if (eventsToConverge <= hardenEfficiencyFloor) return hardenCreditBase;
  if (eventsToConverge >= hardenEfficiencyCeil) return hardenCreditMin;
  const t = (eventsToConverge - hardenEfficiencyFloor) / (hardenEfficiencyCeil - hardenEfficiencyFloor);
  return hardenCreditBase - t * (hardenCreditBase - hardenCreditMin);
}
