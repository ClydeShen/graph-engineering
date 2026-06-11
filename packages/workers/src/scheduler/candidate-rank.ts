/**
 * Multi-candidate ranking (ADR-46 D-2) — advisory ordering layer.
 *
 * Does NOT assign tasks (ADR-42 D-1 stands: agents claim via SKIP LOCKED).
 * Used where a choice must be made: internal delegation target selection,
 * claim-side suggested ordering.
 *
 * score = trust_weight × 0.5 + success_rate × 0.5
 * success_rate uses Laplace smoothing — a new agent with no history degrades
 * to a pure trust signal (declared cold-start behavior).
 */

import type { TrustLevel } from '@graph/types/core';

export interface AgentCandidate {
  agent_id: string;
  trust_level: TrustLevel;
  success_count: number;
  failure_count: number;
  /** Optional second-tier fine tags (ADR-46 D-1) — bonus on overlap. */
  fine_skills?: string[];
}

const TRUST_WEIGHT: Record<TrustLevel, number> = {
  trusted: 1.0,
  paired: 0.6,
  untrusted: 0.2,
};

export function candidateScore(c: AgentCandidate, wantedFineSkills: string[] = []): number {
  const trust = TRUST_WEIGHT[c.trust_level] ?? 0.2;
  const successRate = (c.success_count + 1) / (c.success_count + c.failure_count + 2);
  const fineOverlap =
    wantedFineSkills.length > 0 && c.fine_skills !== undefined
      ? c.fine_skills.filter((s) => wantedFineSkills.includes(s)).length /
        wantedFineSkills.length
      : 0;
  // Fine-tag overlap is a tiebreaker-scale bonus (×0.1), never dominant.
  return trust * 0.5 + successRate * 0.5 + fineOverlap * 0.1;
}

/** Stable descending rank; ties broken by agent_id for determinism. */
export function rankCandidates(
  candidates: AgentCandidate[],
  wantedFineSkills: string[] = [],
): AgentCandidate[] {
  return [...candidates].sort((a, b) => {
    const diff = candidateScore(b, wantedFineSkills) - candidateScore(a, wantedFineSkills);
    if (diff !== 0) return diff;
    return a.agent_id < b.agent_id ? -1 : 1;
  });
}
