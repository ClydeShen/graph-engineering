import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectFromCwd, isProjectArchived, _resetProjectArchivedCache } from './scope-project.js';

describe('projectFromCwd (CONSOLE-REDESIGN §11.1)', () => {
  it('returns a real working folder as the project label', () => {
    expect(projectFromCwd('/home/u/projA')).toBe('/home/u/projA');
  });

  it('treats tmp/ephemeral cwd as no project (null)', () => {
    expect(projectFromCwd(tmpdir())).toBeNull();
    expect(projectFromCwd(join(tmpdir(), 'sandbox-xyz'))).toBeNull();
  });

  it('returns null for empty/undefined cwd', () => {
    expect(projectFromCwd(undefined)).toBeNull();
    expect(projectFromCwd('')).toBeNull();
  });
});

describe('isProjectArchived (§11.3 lazy tombstone)', () => {
  beforeEach(() => _resetProjectArchivedCache());

  it('false for an existing folder, true for a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proj-'));
    try {
      expect(isProjectArchived(dir)).toBe(false);
      rmSync(dir, { recursive: true, force: true });
      _resetProjectArchivedCache(); // bypass the TTL cache for the assertion
      expect(isProjectArchived(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('null/undefined project is never archived', () => {
    expect(isProjectArchived(null)).toBe(false);
    expect(isProjectArchived(undefined)).toBe(false);
  });
});
