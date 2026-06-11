/**
 * candidate-rank.test.ts — ADR-46 D-2 advisory ranking (TD-I two-tier vocabulary).
 */

import { describe, it, expect } from 'vitest';
import { candidateScore, rankCandidates, type AgentCandidate } from './candidate-rank.js';

const agent = (over: Partial<AgentCandidate>): AgentCandidate => ({
  agent_id: 'a',
  trust_level: 'paired',
  success_count: 0,
  failure_count: 0,
  ...over,
});

describe('candidateScore', () => {
  it('higher trust outranks lower trust at equal history', () => {
    expect(candidateScore(agent({ trust_level: 'trusted' })))
      .toBeGreaterThan(candidateScore(agent({ trust_level: 'paired' })));
    expect(candidateScore(agent({ trust_level: 'paired' })))
      .toBeGreaterThan(candidateScore(agent({ trust_level: 'untrusted' })));
  });

  it('history success rate matters at equal trust (Laplace smoothed)', () => {
    const veteran = agent({ success_count: 9, failure_count: 1 });
    const failure = agent({ success_count: 1, failure_count: 9 });
    expect(candidateScore(veteran)).toBeGreaterThan(candidateScore(failure));
  });

  it('new agent degrades to a pure trust signal (declared cold-start behavior)', () => {
    // no history: success_rate = 0.5 regardless of trust — score differs only by trust
    const fresh = agent({});
    expect(candidateScore(fresh)).toBeCloseTo(0.6 * 0.5 + 0.5 * 0.5);
  });

  it('fine-skill overlap is a tiebreaker-scale bonus (second tier, TD-I)', () => {
    const generalist = agent({ agent_id: 'g' });
    const specialist = agent({ agent_id: 's', fine_skills: ['typescript', 'sql-migration'] });
    const ranked = rankCandidates([generalist, specialist], ['typescript']);
    expect(ranked[0]!.agent_id).toBe('s');
    // bonus never dominates: untrusted specialist still loses to trusted generalist
    const untrustedSpecialist = agent({ agent_id: 'u', trust_level: 'untrusted', fine_skills: ['typescript'] });
    const trustedGeneralist = agent({ agent_id: 't', trust_level: 'trusted' });
    expect(rankCandidates([untrustedSpecialist, trustedGeneralist], ['typescript'])[0]!.agent_id).toBe('t');
  });

  it('ranking is deterministic on ties (agent_id order)', () => {
    const a = agent({ agent_id: 'aaa' });
    const b = agent({ agent_id: 'bbb' });
    expect(rankCandidates([b, a]).map((c) => c.agent_id)).toEqual(['aaa', 'bbb']);
  });
});
