import { describe, it, expect } from 'vitest';
import { parseDotenv, loadDotenv } from './dotenv.js';

describe('parseDotenv', () => {
  it('parses KEY=VALUE lines and strips quotes', () => {
    expect(parseDotenv('A=1\nB="two"\nC=\'three\'\n# comment\nbad line')).toEqual({
      A: '1',
      B: 'two',
      C: 'three',
    });
  });
});

describe('loadDotenv', () => {
  it('never overwrites existing env keys (process env > .env)', () => {
    const env = { A: 'kept' } as NodeJS.ProcessEnv;
    // missing file path → no-op
    expect(loadDotenv('definitely-missing.env', env)).toEqual([]);
    expect(env['A']).toBe('kept');
  });
});
