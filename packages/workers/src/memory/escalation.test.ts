import { describe, it, expect } from 'vitest';
import { selectShakyTemplates, formatVerificationReport, type TemplateStat } from './escalation.js';

const stat = (over: Partial<TemplateStat>): TemplateStat => ({
  id: 't',
  quality_score: 0.9,
  evidence: 10,
  intent_description: 'write_api before db_schema.',
  ...over,
});

const FLOORS = { gateQualityFloor: 0.7, gateEvidenceFloor: 5 };

describe('selectShakyTemplates', () => {
  it('flags well-evidenced templates below the quality floor', () => {
    const shaky = selectShakyTemplates([stat({ id: 'bad', quality_score: 0.4, evidence: 8 })], FLOORS);
    expect(shaky.map((s) => s.id)).toEqual(['bad']);
  });

  it('stays silent on confidently-good ingredients', () => {
    expect(selectShakyTemplates([stat({ quality_score: 0.95, evidence: 12 })], FLOORS)).toEqual([]);
  });

  it('does NOT flag unproven (thin-evidence) templates — no spurious cold-start escalation', () => {
    // low quality but only 2 prior runs → unproven, left silent by default policy
    expect(selectShakyTemplates([stat({ quality_score: 0.3, evidence: 2 })], FLOORS)).toEqual([]);
  });

  it('returns empty for no injected templates (true cold start)', () => {
    expect(selectShakyTemplates([], FLOORS)).toEqual([]);
  });
});

describe('formatVerificationReport', () => {
  it('returns null when nothing is shaky (proceed silently)', () => {
    expect(formatVerificationReport([])).toBeNull();
  });

  it('emits a sparse report with success-rate and only the learned constraints', () => {
    const report = formatVerificationReport([
      stat({ id: 'bad', quality_score: 0.4, evidence: 8, intent_description: 'Preamble prose. write_api before db_schema. security_scan before containerize.' }),
    ])!;
    expect(report).toContain('success rate 40%');
    expect(report).toContain('8 prior runs');
    expect(report).toContain('write_api before db_schema');
    expect(report).toContain('security_scan before containerize');
    expect(report).not.toContain('Preamble prose'); // non-constraint prose excluded
  });

  it('handles a shaky template with no explicit ordering rule', () => {
    const report = formatVerificationReport([stat({ quality_score: 0.4, intent_description: 'just a summary' })])!;
    expect(report).toContain('no explicit ordering rule recorded');
  });
});
