import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceRoot, ensureWorkspaceRoots, workspacesRoot } from './workspace.js';

let base: string;
afterEach(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe('ensureWorkspaceRoot (CONSOLE-REDESIGN §11.1/§11.4)', () => {
  it('creates a folder root with artifacts/ + AGENTS.md', () => {
    base = mkdtempSync(join(tmpdir(), 'ws-'));
    const dir = ensureWorkspaceRoot('telegram', base);
    expect(dir).toBe(join(workspacesRoot(base), 'telegram'));
    expect(existsSync(join(dir, 'artifacts'))).toBe(true);
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(true);
  });

  it('is idempotent and never overwrites a user AGENTS.md', () => {
    base = mkdtempSync(join(tmpdir(), 'ws-'));
    const dir = ensureWorkspaceRoot('console', base);
    writeFileSync(join(dir, 'AGENTS.md'), 'CUSTOM', 'utf8');
    ensureWorkspaceRoot('console', base); // second run
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe('CUSTOM');
  });

  it('ensureWorkspaceRoots dedupes and creates each', () => {
    base = mkdtempSync(join(tmpdir(), 'ws-'));
    const dirs = ensureWorkspaceRoots(['console', 'telegram', 'console'], base);
    expect(dirs).toHaveLength(2);
    expect(dirs.every((d) => existsSync(d))).toBe(true);
  });
});
