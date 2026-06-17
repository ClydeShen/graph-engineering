import { describe, it, expect } from 'vitest';
import {
  extractStepOrder,
  parseOrderingRules,
  checkConformance,
  type ConformanceEvent,
} from './conformance.js';

const ev = (event_type: string, payload: Record<string, unknown>): ConformanceEvent => ({
  event_type,
  payload: JSON.stringify(payload),
});

// The verbatim phrasing the crystallization / golden prompts emit (dag.ts).
const GOLDEN_LESSON =
  'Runbook to stand up a microservice. SIX rules reverse intuition: ' +
  'write_api before db_schema (schema is derived from the API spec); ' +
  'security_scan before containerize (it scans source dependencies); ' +
  'build_image before run_tests (tests run inside the built image). ' +
  'Correct order: scaffold -> add_deps -> write_api -> db_schema.';

const VOCAB = [
  'scaffold', 'add_deps', 'write_api', 'db_schema', 'security_scan',
  'containerize', 'build_image', 'run_tests',
];

describe('extractStepOrder', () => {
  it('pulls step tokens from task_spawned payloads in ledger order, lower-cased', () => {
    const events = [
      ev('plan_created', { intent: 'x' }),
      ev('task_spawned', { step: 'Write_API', required_skills: ['svc'] }),
      ev('memory_updated', { memory_type: 'episodic' }),
      ev('task_spawned', { step: 'db_schema' }),
    ];
    expect(extractStepOrder(events)).toEqual(['write_api', 'db_schema']);
  });

  it('falls back to description / task and skips token-less or unparseable payloads', () => {
    const events = [
      ev('task_spawned', { description: 'Deploy' }),
      ev('task_spawned', { task: 'smoke_test' }),
      ev('task_spawned', { other: 'no-token' }),
      { event_type: 'task_spawned', payload: 'not json' },
    ];
    expect(extractStepOrder(events)).toEqual(['deploy', 'smoke_test']);
  });
});

describe('parseOrderingRules', () => {
  it('parses "X before Y" rules grounded in the step vocabulary', () => {
    const rules = parseOrderingRules(GOLDEN_LESSON, VOCAB);
    expect(rules).toEqual(
      expect.arrayContaining([
        { before: 'write_api', after: 'db_schema' },
        { before: 'security_scan', after: 'containerize' },
        { before: 'build_image', after: 'run_tests' },
      ]),
    );
  });

  it('parses explicit order chains "a -> b -> c" into adjacency rules', () => {
    const rules = parseOrderingRules('Correct order: scaffold -> add_deps -> write_api.', VOCAB);
    expect(rules).toEqual([
      { before: 'scaffold', after: 'add_deps' },
      { before: 'add_deps', after: 'write_api' },
    ]);
  });

  it('does not reach across clause boundaries and ignores non-vocab tokens', () => {
    const rules = parseOrderingRules('do laundry before dinner. write_api before db_schema.', VOCAB);
    expect(rules).toEqual([{ before: 'write_api', after: 'db_schema' }]);
  });

  it('returns no rules for empty vocab or empty lesson (fail-closed at caller)', () => {
    expect(parseOrderingRules(GOLDEN_LESSON, [])).toEqual([]);
    expect(parseOrderingRules('', VOCAB)).toEqual([]);
  });
});

describe('checkConformance', () => {
  const rules = [
    { before: 'write_api', after: 'db_schema' },
    { before: 'build_image', after: 'run_tests' },
  ];

  it('conformed when every applicable rule holds', () => {
    const order = ['write_api', 'db_schema', 'build_image', 'run_tests'];
    expect(checkConformance(rules, order)).toBe('conformed');
  });

  it('violated when an applicable rule is reversed (cooking mistake → out of scope)', () => {
    const order = ['db_schema', 'write_api', 'build_image', 'run_tests'];
    expect(checkConformance(rules, order)).toBe('violated');
  });

  it('not-applicable when no rule has both tokens exercised', () => {
    expect(checkConformance(rules, ['scaffold', 'add_deps'])).toBe('not-applicable');
    expect(checkConformance(rules, ['write_api' /* db_schema absent */])).toBe('not-applicable');
  });

  it('uses first occurrence for ordering (transitive precedence via index)', () => {
    // build_image appears, then run_tests, then build_image again → first<first holds.
    const order = ['build_image', 'run_tests', 'build_image'];
    expect(checkConformance([{ before: 'build_image', after: 'run_tests' }], order)).toBe('conformed');
  });

  it('tolerance lets a partial-order violation still count as conformed', () => {
    const order = ['db_schema', 'write_api', 'build_image', 'run_tests']; // 1 of 2 violated
    expect(checkConformance(rules, order, 0)).toBe('violated');
    expect(checkConformance(rules, order, 0.5)).toBe('conformed'); // 0.5 ratio not exceeded
  });
});
