/**
 * Mid-flight escalation gate (GH #33, P3) — the freshness signal read a SECOND
 * time, before the agent acts.
 *
 * A plan rests on "confidently-good" ingredients when every injected template
 * clears both the quality and evidence floors; then the turn proceeds silently.
 * Otherwise the gate emits a SPARSE verification report — only the shaky
 * template's learned constraints ("X before Y" lines) plus its success-rate — so
 * a human can verify the key steps before committing. This reuses the same
 * evidence signal as the P2 metabolism (one substrate, two read-times); no new
 * threshold is introduced.
 *
 * Default policy (calibration-deferred, #35): only templates with MEANINGFUL
 * evidence (≥ gateEvidenceFloor) that nonetheless score below the quality floor
 * are "shaky". A brand-new, untested template (evidence below the floor) is
 * "unproven" and is left silent — otherwise every cold start on a freshly seeded
 * memory would escalate spuriously. #35 can lower the evidence floor to also flag
 * the unproven if the data warrants it.
 *
 * @see .harness/implementation-notes.md "Freshness-substrate design discuss" §P3
 */

import { FRESHNESS } from './freshness-config.js';

/** Per-injected-template freshness (subset of MemReflectOutput.proceduralStats). */
export interface TemplateStat {
  id: string;
  /** Laplace quality_score = (success+1)/(success+failure+1). */
  quality_score: number;
  /** Evidence volume = success_count + failure_count. */
  evidence: number;
  /** The readable lesson (carries the "X before Y" constraints). */
  intent_description: string | null;
}

/** Templates the plan rests on that are well-evidenced yet below the quality floor. */
export function selectShakyTemplates(
  stats: readonly TemplateStat[],
  floors: { gateQualityFloor: number; gateEvidenceFloor: number } = FRESHNESS,
): TemplateStat[] {
  return stats.filter(
    (s) => s.evidence >= floors.gateEvidenceFloor && s.quality_score < floors.gateQualityFloor,
  );
}

/** The learned ordering constraints in a lesson — the "key steps" to verify. */
function constraintLines(lesson: string | null): string[] {
  if (!lesson) return [];
  return lesson
    .split(/[;.\n]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && (/\bbefore\b/i.test(c) || /->|→/.test(c)));
}

/**
 * A sparse, human-readable verification report for the shaky templates, or null
 * when nothing is shaky (→ proceed silently). Each entry shows the success-rate
 * and only the learned constraints, never the whole lesson.
 */
export function formatVerificationReport(shaky: readonly TemplateStat[]): string | null {
  if (shaky.length === 0) return null;
  const blocks = shaky.map((s) => {
    const pct = Math.round(s.quality_score * 100);
    const lines = constraintLines(s.intent_description);
    const steps = lines.length > 0 ? lines.map((l) => `  - ${l}`).join('\n') : '  - (no explicit ordering rule recorded)';
    return `Recalled procedure (success rate ${pct}%, ${s.evidence} prior runs) — verify these key steps:\n${steps}`;
  });
  return ['## Verify before proceeding (shaky recalled procedures)', ...blocks].join('\n\n');
}
